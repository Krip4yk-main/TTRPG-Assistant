import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth.api';
import type { MeDto } from './me.model';
import { SocketService } from '../realtime/socket.service';
import { safeReturnTo } from './return-to';

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

  private readonly state = signal<MeDto | null>(null);
  private readonly known = signal(false);
  private readonly failed = signal(false);
  private loading: Promise<void> | null = null;
  private blockedUrl: string | null = null;

  readonly me = this.state.asReadonly();
  readonly isAuthenticated = computed(() => this.state() !== null);
  readonly isPending = computed(() => this.state()?.status === 'pending');
  readonly isActive = computed(() => this.state()?.status === 'active');
  /** Останнє `load()` завершилося не-401 помилкою (сервер/мережа). */
  readonly loadFailed = this.failed.asReadonly();
  /** Стан ще жодного разу не вдалося визначити. */
  readonly isUnknown = computed(() => !this.known() && this.failed());

  constructor() {
    // Сервер відкликав сесію або інша вкладка вийшла: перевіряємо, чи сесія ще жива.
    this.socket.sessionLost$.subscribe(() => void this.revalidate());
    if (this.channel) this.channel.onmessage = () => void this.revalidate();
  }

  /** `GET /api/me` (заодно отримує куку CSRF). */
  load(): Promise<void> {
    this.loading = firstValueFrom(this.api.me()).then(
      (me) => this.setMe(me),
      (err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 401) this.setMe(null);
        else this.failed.set(true);
      },
    );
    return this.loading;
  }

  /**
   * Перевіряє сесію після сигналу «втрачено». Лише 401 розлогінює й веде на /login;
   * інші помилки (мережа, 5xx) стан не змінюють. Router береться ліниво (цикл DI).
   */
  revalidate(): Promise<void> {
    if (!this.isAuthenticated()) return Promise.resolve();
    this.revalidating ??= firstValueFrom(this.api.me())
      .then(
        () => undefined,
        (err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 401) {
            this.setMe(null);
            const router = this.injector.get(Router);
            const returnTo = safeReturnTo(router.url);
            if (!router.url.startsWith('/login')) {
              void router.navigate(['/login'], {
                queryParams: { error: 'UNAUTHENTICATED', ...(returnTo ? { returnTo } : {}) },
              });
            }
          } else {
            this.failed.set(true);
          }
        },
      )
      .finally(() => (this.revalidating = null));
    return this.revalidating;
  }

  /** Для guard-ів: чекає першого завантаження, не повторюючи запит. */
  ensureLoaded(): Promise<void> {
    return this.loading ?? this.load();
  }

  setMe(me: MeDto | null): void {
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
    try {
      await firstValueFrom(this.api.logout());
    } finally {
      this.setMe(null);
      this.channel?.postMessage('logout');
    }
  }

  async logoutAll(): Promise<void> {
    try {
      await firstValueFrom(this.api.logoutAll());
    } finally {
      this.setMe(null);
      this.channel?.postMessage('logout');
    }
  }
}
