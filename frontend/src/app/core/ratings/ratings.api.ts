import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { RatingInput, RatingTargetDto, RatingTargetsDto } from '@nri/shared';

/** Тонкий шар над HTTP API оцінювання: цілі, надсилання й «кого я можу оцінити». */
@Injectable({ providedIn: 'root' })
export class RatingsApi {
  private readonly http = inject(HttpClient);

  /** Кого я можу оцінити в грі: після сесії (`sessionId`) або підсумково. */
  targets(gameId: number, sessionId?: number): Observable<RatingTargetsDto> {
    const params: Record<string, string> =
      sessionId === undefined ? {} : { sessionId: String(sessionId) };
    return this.http.get<RatingTargetsDto>(`/api/games/${gameId}/ratings/targets`, { params });
  }

  /** Оцінка або відмова; відповідь — ціль у новому стані (`rated`/`declined`). */
  submit(gameId: number, input: RatingInput): Observable<RatingTargetDto> {
    return this.http.post<RatingTargetDto>(`/api/games/${gameId}/ratings`, input);
  }

  /** Набори з відкритими цілями (найближчий дедлайн першим). */
  pending(): Observable<RatingTargetsDto[]> {
    return this.http.get<RatingTargetsDto[]>('/api/me/ratings/pending');
  }
}
