import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CompleteProfileInput,
  DevLoginInput,
  IdentityDto,
  IdentityProvider,
  MeDto,
} from '@nri/shared';

/** Дані Telegram Login Widget (передаються бекенду як є для перевірки підпису). */
export type TelegramAuthData = Record<string, string | number>;

export type GoogleMode = 'login' | 'link';

/** Тонкий шар над HTTP API автентифікації та профілю. */
@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);

  me(): Observable<MeDto> {
    return this.http.get<MeDto>('/api/me');
  }

  telegramLogin(data: TelegramAuthData): Observable<{ user: MeDto }> {
    return this.http.post<{ user: MeDto }>('/api/auth/telegram', data);
  }

  devLogin(input: DevLoginInput): Observable<{ user: MeDto }> {
    return this.http.post<{ user: MeDto }>('/api/auth/dev-login', input);
  }

  logout(): Observable<unknown> {
    return this.http.post('/api/auth/logout', {});
  }

  logoutAll(): Observable<unknown> {
    return this.http.post('/api/auth/logout-all', {});
  }

  completeProfile(input: CompleteProfileInput): Observable<MeDto> {
    return this.http.post<MeDto>('/api/me/complete-profile', input);
  }

  changeBirthDate(birthDate: string): Observable<MeDto> {
    return this.http.patch<MeDto>('/api/me/birth-date', { birthDate });
  }

  unlinkIdentity(provider: IdentityProvider): Observable<{ identities: IdentityDto[] }> {
    return this.http.delete<{ identities: IdentityDto[] }>(
      `/api/me/identities/${encodeURIComponent(provider)}`,
    );
  }

  deleteAccount(): Observable<unknown> {
    return this.http.delete('/api/me');
  }

  telegramLinkToken(): Observable<{ url: string }> {
    return this.http.post<{ url: string }>('/api/me/telegram-link-token', {});
  }

  /** URL для повної навігації браузера (OAuth-редирект, не XHR). */
  googleStartUrl(mode: GoogleMode, returnTo: string): string {
    const q = new URLSearchParams({ mode, returnTo });
    return `/api/auth/google/start?${q.toString()}`;
  }
}
