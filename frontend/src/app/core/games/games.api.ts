import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { GameCardDto, GameDto, GameInput, GamePatch, GameViewDto } from '@nri/shared';

/** Переходи статусу гри (`POST /api/games/:id/<action>`). */
export const GAME_ACTIONS = ['publish', 'start', 'finish', 'cancel'] as const;
export type GameAction = (typeof GAME_ACTIONS)[number];

/** Тонкий шар над HTTP API ігор. */
@Injectable({ providedIn: 'root' })
export class GamesApi {
  private readonly http = inject(HttpClient);

  /** Створює чернетку. */
  create(input: GameInput): Observable<GameDto> {
    return this.http.post<GameDto>('/api/games', input);
  }

  update(id: number, patch: GamePatch): Observable<GameDto> {
    return this.http.patch<GameDto>(`/api/games/${id}`, patch);
  }

  get(id: number): Observable<GameViewDto> {
    return this.http.get<GameViewDto>(`/api/games/${id}`);
  }

  mine(): Observable<GameCardDto[]> {
    return this.http.get<GameCardDto[]>('/api/games/mine');
  }

  transition(id: number, action: GameAction): Observable<GameDto> {
    return this.http.post<GameDto>(`/api/games/${id}/${action}`, {});
  }
}
