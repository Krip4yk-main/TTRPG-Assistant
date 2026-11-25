import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CalendarSettingsDto,
  CalendarSettingsPatch,
  GameBusyDto,
  PinnedGamesDto,
} from '@nri/shared';

/** Налаштування календаря, ігри, додані вручну, і зайнятість від ігор (`/api/me/…`). */
@Injectable({ providedIn: 'root' })
export class CalendarApi {
  private readonly http = inject(HttpClient);

  settings(): Observable<CalendarSettingsDto> {
    return this.http.get<CalendarSettingsDto>('/api/me/settings');
  }

  updateSettings(patch: CalendarSettingsPatch): Observable<CalendarSettingsDto> {
    return this.http.patch<CalendarSettingsDto>('/api/me/settings', patch);
  }

  pinnedGames(): Observable<PinnedGamesDto> {
    return this.http.get<PinnedGamesDto>('/api/me/calendar/pinned-games');
  }

  pin(gameId: number): Observable<void> {
    return this.http.post<void>(`/api/me/calendar/pinned-games/${gameId}`, null);
  }

  unpin(gameId: number): Observable<void> {
    return this.http.delete<void>(`/api/me/calendar/pinned-games/${gameId}`);
  }

  /** Сесії ігор у `[from, to)` (≤ 93 діб); миті — ISO UTC. */
  gameBusy(from: Date, to: Date): Observable<GameBusyDto[]> {
    return this.http.get<GameBusyDto[]>('/api/me/calendar/game-busy', {
      params: { from: from.toISOString(), to: to.toISOString() },
    });
  }
}
