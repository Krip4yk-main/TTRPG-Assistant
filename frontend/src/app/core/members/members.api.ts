import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { BlacklistEntryDto, MemberDto } from '@nri/shared';

/** Тонкий шар над HTTP API складу гри й чорного списку майстра. */
@Injectable({ providedIn: 'root' })
export class MembersApi {
  private readonly http = inject(HttpClient);

  list(gameId: number): Observable<MemberDto[]> {
    return this.http.get<MemberDto[]>(`/api/games/${gameId}/members`);
  }

  /** Виключити учасника (може подати заявку знову). */
  kick(gameId: number, publicId: string): Observable<void> {
    return this.http.post<void>(`/api/games/${gameId}/members/${publicId}/kick`, {});
  }

  /** Забанити в цій грі (виключає й блокує нові заявки на гру). */
  ban(gameId: number, publicId: string): Observable<void> {
    return this.http.post<void>(`/api/games/${gameId}/members/${publicId}/ban`, {});
  }

  blacklist(): Observable<BlacklistEntryDto[]> {
    return this.http.get<BlacklistEntryDto[]>('/api/me/blacklist');
  }

  /** Додати до чорного списку майстра (не виключає з поточних ігор). */
  addToBlacklist(publicId: string): Observable<BlacklistEntryDto> {
    return this.http.post<BlacklistEntryDto>(`/api/me/blacklist/${publicId}`, {});
  }

  removeFromBlacklist(publicId: string): Observable<void> {
    return this.http.delete<void>(`/api/me/blacklist/${publicId}`);
  }
}
