import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CommonTimesDto,
  PollApplyInput,
  PollApplyResultDto,
  PollCreateInput,
  PollDto,
  PollVotesInput,
  SessionAlternativesDto,
} from '@nri/shared';

/**
 * Спільний час групи (Plan 12): підбір часу й альтернативи сесії (лише майстер гри) та
 * голосування за час (майстер створює, закриває й застосовує; голосують активні учасники).
 */
@Injectable({ providedIn: 'root' })
export class SchedulingApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/games/:id/common-times` — кандидати на 4 тижні (або `weeks`). */
  commonTimes(gameId: number, weeks?: number): Observable<CommonTimesDto> {
    const params: Record<string, string> = weeks ? { weeks: String(weeks) } : {};
    return this.http.get<CommonTimesDto>(`/api/games/${gameId}/common-times`, { params });
  }

  /** `GET /api/sessions/:id/alternatives` — до 3 варіантів у ±3 доби від сесії. */
  alternatives(sessionId: number): Observable<SessionAlternativesDto> {
    return this.http.get<SessionAlternativesDto>(`/api/sessions/${sessionId}/alternatives`);
  }

  polls(gameId: number): Observable<PollDto[]> {
    return this.http.get<PollDto[]>(`/api/games/${gameId}/polls`);
  }

  createPoll(gameId: number, input: PollCreateInput): Observable<PollDto> {
    return this.http.post<PollDto>(`/api/games/${gameId}/polls`, input);
  }

  vote(pollId: number, input: PollVotesInput): Observable<PollDto> {
    return this.http.put<PollDto>(`/api/polls/${pollId}/votes`, input);
  }

  closePoll(pollId: number): Observable<PollDto> {
    return this.http.post<PollDto>(`/api/polls/${pollId}/close`, null);
  }

  applyPoll(pollId: number, input: PollApplyInput): Observable<PollApplyResultDto> {
    return this.http.post<PollApplyResultDto>(`/api/polls/${pollId}/apply`, input);
  }
}
