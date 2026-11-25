import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ComplaintCreatedDto,
  ComplaintInput,
  MySanctionDto,
  SanctionAppealInput,
} from '@nri/shared';

/**
 * Модерація з боку користувача: скарга (`POST /api/complaints`; 403 `COMPLAINT_NOT_ALLOWED` —
 * бекенд вирішує, чи можна скаржитись), мої чинні санкції та апеляція на санкцію (одна на
 * санкцію: 409 `APPEAL_EXISTS`; знята чи прострочена — 409 `SANCTION_NOT_ACTIVE`).
 */
@Injectable({ providedIn: 'root' })
export class ModerationApi {
  private readonly http = inject(HttpClient);

  complain(input: ComplaintInput): Observable<ComplaintCreatedDto> {
    return this.http.post<ComplaintCreatedDto>('/api/complaints', input);
  }

  mySanctions(): Observable<MySanctionDto[]> {
    return this.http.get<MySanctionDto[]>('/api/me/sanctions');
  }

  appeal(sanctionId: number, input: SanctionAppealInput): Observable<MySanctionDto> {
    return this.http.post<MySanctionDto>(`/api/me/sanctions/${sanctionId}/appeal`, input);
  }
}
