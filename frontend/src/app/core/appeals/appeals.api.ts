import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AppealInput } from '@nri/shared';

/**
 * Апеляція заблокованого користувача. Без сесії — лише за одноразовим токеном з
 * помилки `ACCOUNT_BANNED`: 201 `{ id }`; 409 `APPEAL_EXISTS` — уже надіслано;
 * 401 — токен недійсний чи прострочений; 403 — акаунт уже розблоковано.
 */
@Injectable({ providedIn: 'root' })
export class AppealsApi {
  private readonly http = inject(HttpClient);

  create(input: AppealInput): Observable<{ id: number }> {
    return this.http.post<{ id: number }>('/api/appeals', input);
  }
}
