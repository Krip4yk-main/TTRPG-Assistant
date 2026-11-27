import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  NotificationDto,
  NotificationPrefsDto,
  NotificationPrefsInput,
  NotificationsPage,
  UnreadCountDto,
} from '@nri/shared';

/** Сповіщення поточного користувача й налаштування їх доставки. */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly http = inject(HttpClient);

  /** Сторінка сповіщень (новіші першими); `cursor` — з попередньої сторінки. */
  list(cursor?: number | null, limit?: number): Observable<NotificationsPage> {
    let params = new HttpParams();
    if (cursor) params = params.set('cursor', cursor);
    if (limit) params = params.set('limit', limit);
    return this.http.get<NotificationsPage>('/api/me/notifications', { params });
  }

  unreadCount(): Observable<UnreadCountDto> {
    return this.http.get<UnreadCountDto>('/api/me/notifications/unread-count');
  }

  markRead(id: number): Observable<NotificationDto> {
    return this.http.post<NotificationDto>(`/api/me/notifications/${id}/read`, {});
  }

  markAllRead(): Observable<void> {
    return this.http.post<void>('/api/me/notifications/read-all', {});
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/me/notifications/${id}`);
  }

  /** Видаляє всі прочитані; повертає кількість видалених. */
  removeRead(): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>('/api/me/notifications/read');
  }

  prefs(): Observable<NotificationPrefsDto> {
    return this.http.get<NotificationPrefsDto>('/api/me/notification-prefs');
  }

  updatePrefs(input: NotificationPrefsInput): Observable<NotificationPrefsDto> {
    return this.http.put<NotificationPrefsDto>('/api/me/notification-prefs', input);
  }
}
