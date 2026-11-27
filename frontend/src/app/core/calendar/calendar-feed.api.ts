import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { CalendarFeedCreatedDto, CalendarFeedStatusDto } from '@nri/shared';

/**
 * Вихідна ICS-підписка на «мої сесії» (`/api/me/calendar-feed`). Посилання сервер повертає
 * лише у відповідь на створення/перевипуск — повторно його не отримати.
 */
@Injectable({ providedIn: 'root' })
export class CalendarFeedApi {
  private readonly http = inject(HttpClient);

  status(): Observable<CalendarFeedStatusDto> {
    return this.http.get<CalendarFeedStatusDto>('/api/me/calendar-feed');
  }

  /** Створює або перевипускає посилання (старе одразу перестає працювати). */
  issue(): Observable<CalendarFeedCreatedDto> {
    return this.http.post<CalendarFeedCreatedDto>('/api/me/calendar-feed', null);
  }

  disable(): Observable<void> {
    return this.http.delete<void>('/api/me/calendar-feed');
  }
}
