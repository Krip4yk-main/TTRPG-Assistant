import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from './auth.api';
import type { MeDto } from './me.model';
import { SocketService } from '../realtime/socket.service';

/**
 * Стан автентифікації на сигналах. Бекенд — джерело істини: стан оновлюється лише
 * з відповідей API. Сокет підключений, доки користувач активний.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(AuthApi);
  private readonly socket = inject(SocketService);

  private readonly state = signal<MeDto | null>(null);
  private loading: Promise<void> | null = null;

  readonly me = this.state.asReadonly();
  readonly isAuthenticated = computed(() => this.state() !== null);
  readonly isPending = computed(() => this.state()?.status === 'pending');
  readonly isActive = computed(() => this.state()?.status === 'active');

  /** `GET /api/me` (заодно отримує куку CSRF). Будь-яка помилка → гість. */
  load(): Promise<void> {
    this.loading = firstValueFrom(this.api.me()).then(
      (me) => this.setMe(me),
      () => this.setMe(null),
    );
    return this.loading;
  }

  /** Для guard-ів: чекає першого завантаження, не повторюючи запит. */
  ensureLoaded(): Promise<void> {
    return this.loading ?? this.load();
  }

  setMe(me: MeDto | null): void {
    this.state.set(me);
    this.loading ??= Promise.resolve();
    if (me?.status === 'active') this.socket.connect();
    else this.socket.disconnect();
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
