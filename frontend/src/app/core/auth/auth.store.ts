import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth.api';
import type { MeDto } from './me.model';
import { SocketService } from '../realtime/socket.service';

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
    }
  }

  async logoutAll(): Promise<void> {
    try {
      await firstValueFrom(this.api.logoutAll());
    } finally {
      this.setMe(null);
    }
  }
}
