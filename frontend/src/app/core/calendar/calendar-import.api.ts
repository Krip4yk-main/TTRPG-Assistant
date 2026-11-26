import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { CalendarImportStatusDto } from '@nri/shared';

/**
 * Імпорт зайнятості з приватного iCal-посилання (`/api/me/calendar-import`). Посилання сервер
 * ніколи не повертає — лише хост і стан синхронізації.
 */
@Injectable({ providedIn: 'root' })
export class CalendarImportApi {
  private readonly http = inject(HttpClient);

  status(): Observable<CalendarImportStatusDto> {
    return this.http.get<CalendarImportStatusDto>('/api/me/calendar-import');
  }

  /** Перевіряє й одразу завантажує посилання; зберігає лише після успіху. */
  connect(url: string): Observable<CalendarImportStatusDto> {
    return this.http.put<CalendarImportStatusDto>('/api/me/calendar-import', { url });
  }

  /** Невдале завантаження — теж 200, причина в `lastError`. */
  sync(): Observable<CalendarImportStatusDto> {
    return this.http.post<CalendarImportStatusDto>('/api/me/calendar-import/sync', null);
  }

  /** Видаляє посилання й усю імпортовану зайнятість. */
  disconnect(): Observable<void> {
    return this.http.delete<void>('/api/me/calendar-import');
  }
}
