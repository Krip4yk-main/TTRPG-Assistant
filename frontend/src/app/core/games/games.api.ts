import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  GameAction,
  GameDto,
  GameInput,
  GamePatch,
  GameTransitionDto,
  GameViewDto,
  MyDeadGameDto,
  MyDeadGamesDto,
  MyGameCardDto,
  ScheduleRuleInput,
  SearchFiltersInput,
  SearchResultDto,
} from '@nri/shared';

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

  /** Публічний пошук (`calendar.mode = 'mine'` — лише з сесією). */
  search(filters: SearchFiltersInput): Observable<SearchResultDto> {
    return this.http.post<SearchResultDto>('/api/games/search', filters);
  }

  /** «Мої ігри» майстра: картки з кількістю учасників і нових заявок. */
  mine(): Observable<MyGameCardDto[]> {
    return this.http.get<MyGameCardDto[]>('/api/games/mine');
  }

  /** Нове правило розкладу кампанії (майбутні сесії з правила перебудовуються). */
  changeSchedule(id: number, input: ScheduleRuleInput): Observable<GameDto> {
    return this.http.put<GameDto>(`/api/games/${id}/schedule`, input);
  }

  /** Ваншот → кампанія з новим правилом регулярності. */
  convertToCampaign(id: number, input: ScheduleRuleInput): Observable<GameDto> {
    return this.http.post<GameDto>(`/api/games/${id}/convert-to-campaign`, input);
  }

  transition(id: number, action: GameAction): Observable<GameTransitionDto> {
    return this.http.post<GameTransitionDto>(`/api/games/${id}/${action}`, {});
  }

  /** Ігри майстра з позначками «давно не проводилась» / «мертва» / «підозріла». */
  myDeadGames(): Observable<MyDeadGamesDto> {
    return this.http.get<MyDeadGamesDto>('/api/me/dead-games');
  }

  /** «Все ок»: знімає позначку «мертва» (повернеться через 14 днів, якщо сесій не буде). */
  stillAlive(id: number): Observable<MyDeadGameDto> {
    return this.http.post<MyDeadGameDto>(`/api/games/${id}/still-alive`, {});
  }

  /** Закрити гру з позначкою: набір → скасована, почата → завершена. */
  closeDead(id: number): Observable<GameTransitionDto> {
    return this.http.post<GameTransitionDto>(`/api/games/${id}/close-dead`, {});
  }
}
