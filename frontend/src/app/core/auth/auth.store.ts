import { DestroyRef, Injectable, Injector, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { filter, firstValueFrom, take } from 'rxjs';
import { AuthApi } from './auth.api';
import type { BannedLoginDetails, MeDto } from '@nri/shared';
import { SocketService, type SessionLostReason } from '../realtime/socket.service';
import { safeReturnTo } from './return-to';
import { bannedDetailsOf, isAccountBanned } from './banned';
import { clearAllGameDrafts } from '../games/game-draft-storage';
import { clearAllNoteDrafts } from '../notes/note-draft-storage';

const CHANNEL_NAME = 'nri-auth';

/**
 * Стан автентифікації на сигналах. Бекенд — джерело істини: стан оновлюється лише
 * з відповідей API. Сокет підключений, доки користувач активний.
 *
 * Лише 401 від `/api/me` означає «гість». 5xx або мережева помилка не змінюють
 * відомий стан, а ставлять `loadFailed`; якщо стан ще ніколи не був відомий —
 * `isUnknown()` (guard-и тоді не пускають на захищені сторінки, а показується банер).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(AuthApi);
  private readonly socket = inject(SocketService);
  private readonly injector = inject(Injector);
  private readonly channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  private revalidating: Promise<void> | null = null;
  private loggingOut = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly state = signal<MeDto | null>(null);
  private readonly known = signal(false);
  private readonly failed = signal(false);
  private loading: Promise<void> | null = null;
  private blockedUrl: string | null = null;
  private readonly ban = signal<BannedLoginDetails | null>(null);

  readonly me = this.state.asReadonly();
  readonly isAuthenticated = computed(() => this.state() !== null);
  readonly isPending = computed(() => this.state()?.status === 'pending');
  readonly isActive = computed(() => this.state()?.status === 'active');
  /** Останнє `load()` завершилося не-401 помилкою (сервер/мережа). */
  readonly loadFailed = this.failed.asReadonly();
  /** Стан ще жодного разу не вдалося визначити. */
  readonly isUnknown = computed(() => !this.known() && this.failed());
  /**
   * Бан посеред сесії: токен апеляції тримаємо лише в пам'яті (не в адресі) — сторінка
   * входу забирає його (`clearPendingBan`) і показує форму апеляції.
   */
  readonly pendingBan = this.ban.asReadonly();

  constructor() {
    // Сервер відкликав сесію або інша вкладка вийшла: перевіряємо, чи сесія ще жива.
    this.socket.sessionLost$
      .pipe(takeUntilDestroyed())
      .subscribe((reason) => void this.revalidate(reason));
    if (this.channel) this.channel.onmessage = () => void this.revalidate();
    inject(DestroyRef).onDestroy(() => {
      this.channel?.close();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    });
  }

  /** `GET /api/me` (заодно отримує куку CSRF). */
  load(): Promise<void> {
    this.loading = firstValueFrom(this.api.me()).then(
      (me) => this.setMe(me),
      (err: unknown) => {
        if (isAccountBanned(err)) this.accountBanned(bannedDetailsOf(err));
        else if (err instanceof HttpErrorResponse && err.status === 401) this.setMe(null);
        else this.failed.set(true);
      },
    );
    return this.loading;
  }

  /**
   * Перевіряє сесію після сигналу «втрачено». 401 і 403 ACCOUNT_BANNED розлогінюють
   * і ведуть на /login; 200 оновлює стан; інші помилки (мережа, 5xx) стан не змінюють.
   * Router береться ліниво (цикл DI). Ігнорується, поки триває власний вихід.
   */
  revalidate(reason?: SessionLostReason): Promise<void> {
    if (this.loggingOut > 0 || !this.isAuthenticated()) return Promise.resolve();
    this.revalidating ??= firstValueFrom(this.api.me())
      .then(
        (me) => {
          if (this.loggingOut > 0 || !this.isAuthenticated()) return;
          if (reason === 'auth-error') {
            // Рукостискання відхилене, а /api/me каже «живий»: оновлюємо лише стан,
            // без перепідключення й без скидання лічильника (інакше цикл на швидкості мережі).
            this.state.set(me);
            this.failed.set(false);
            return;
          }
          this.reconnectAttempts = 0;
          this.setMe(me);
        },
        (err: unknown) => {
          if (this.loggingOut > 0 || !this.isAuthenticated()) return;
          if (isAccountBanned(err)) {
            this.accountBanned(bannedDetailsOf(err));
          } else if (err instanceof HttpErrorResponse && err.status === 401) {
            this.setMe(null);
            this.goToLogin('UNAUTHENTICATED');
          } else {
            this.failed.set(true);
            // Сервер розірвав сокет, але перевірити сесію не вдалося: пробуємо перепідключитися.
            if (reason === 'revoked' || reason === 'server-disconnect') this.scheduleReconnect();
          }
        },
      )
      .finally(() => (this.revalidating = null));
    return this.revalidating;
  }

  /**
   * Акаунт заблоковано (сесію бекенд уже відкликав): стан — гість, деталі апеляції — в
   * пам'ять, перехід на /login?error=ACCOUNT_BANNED (без токена в адресі).
   */
  accountBanned(details: BannedLoginDetails | null): void {
    this.ban.set(details);
    this.setMe(null);
    this.goToLogin('ACCOUNT_BANNED');
  }

  clearPendingBan(): void {
    this.ban.set(null);
  }

  private goToLogin(error: string): void {
    const router = this.injector.get(Router);
    if (!router.navigated) {
      // Початкова навігація ще не відбулася (перевірка сесії при старті) — після неї.
      router.events
        .pipe(
          filter(
            (e) =>
              e instanceof NavigationEnd ||
              e instanceof NavigationCancel ||
              e instanceof NavigationError,
          ),
          take(1),
        )
        .subscribe(() => this.goToLogin(error));
      return;
    }
    if (router.url.startsWith('/login')) return;
    const returnTo = safeReturnTo(router.url);
    void router.navigate(['/login'], {
      queryParams: { error, ...(returnTo ? { returnTo } : {}) },
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnectAttempts >= 3) return;
    const delay = 1000 * 2 ** this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isActive()) this.socket.connect();
    }, delay);
  }

  /** Для guard-ів: чекає першого завантаження, не повторюючи запит. */
  ensureLoaded(): Promise<void> {
    return this.loading ?? this.load();
  }

  /**
   * `null` (гість: вихід, втрата сесії, видалення акаунта, вихід в іншій вкладці) також
   * видаляє локальні копії форм ігор і незбережених нотаток — на спільному пристрої вони
   * не мають лишатися.
   */
  setMe(me: MeDto | null): void {
    if (me === null) {
      clearAllGameDrafts();
      clearAllNoteDrafts();
    }
    this.state.set(me);
    this.known.set(true);
    this.failed.set(false);
    this.loading ??= Promise.resolve();
    if (me?.status === 'active') this.socket.connect();
    else this.socket.disconnect();
  }

  /** Guard запам'ятовує сторінку, на яку не пустив через невідомий стан. */
  rememberBlockedUrl(url: string): void {
    this.blockedUrl = url;
  }

  takeBlockedUrl(): string | null {
    const url = this.blockedUrl;
    this.blockedUrl = null;
    return url;
  }

  async logout(): Promise<void> {
    this.loggingOut++;
    try {
      await firstValueFrom(this.api.logout());
    } finally {
      this.loggingOut--;
      this.setMe(null);
      this.channel?.postMessage('logout');
    }
  }

  async logoutAll(): Promise<void> {
    this.loggingOut++;
    try {
      await firstValueFrom(this.api.logoutAll());
    } finally {
      this.loggingOut--;
      this.setMe(null);
      this.channel?.postMessage('logout');
    }
  }
}
