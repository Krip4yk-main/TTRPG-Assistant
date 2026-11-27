import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CancelSessionInput,
  FinishSessionInput,
  RescheduleSessionInput,
  RsvpStatus,
  SessionDto,
  SessionSummaryInput,
} from '@nri/shared';

/** Тонкий шар над HTTP API сесій гри. */
@Injectable({ providedIn: 'root' })
export class SessionsApi {
  private readonly http = inject(HttpClient);

  /** Сесії гри (минулі 30 діб і всі майбутні) — майстру й активним учасникам. */
  list(gameId: number): Observable<SessionDto[]> {
    return this.http.get<SessionDto[]>(`/api/games/${gameId}/sessions`);
  }

  reschedule(id: number, input: RescheduleSessionInput): Observable<SessionDto> {
    return this.http.post<SessionDto>(`/api/sessions/${id}/reschedule`, input);
  }

  cancel(id: number, input: CancelSessionInput): Observable<SessionDto> {
    return this.http.post<SessionDto>(`/api/sessions/${id}/cancel`, input);
  }

  /** Відповідь учасника на майбутню сесію: «буду» / «не зможу». */
  rsvp(id: number, status: RsvpStatus): Observable<SessionDto> {
    return this.http.put<SessionDto>(`/api/sessions/${id}/rsvp`, { status });
  }

  /** Завершити сесію, що вже почалась: присутність кожного учасника + підсумок. */
  finish(id: number, input: FinishSessionInput): Observable<SessionDto> {
    return this.http.post<SessionDto>(`/api/sessions/${id}/finish`, input);
  }

  /** Задати чи змінити підсумок проведеної сесії (лише майстер); порожній — прибрати. */
  setSummary(id: number, input: SessionSummaryInput): Observable<SessionDto> {
    return this.http.put<SessionDto>(`/api/sessions/${id}/summary`, input);
  }

  /** Один раз надіслати підсумок учасникам, що були в грі на час сесії. */
  sendSummary(id: number): Observable<SessionDto> {
    return this.http.post<SessionDto>(`/api/sessions/${id}/summary/send`, {});
  }
}
