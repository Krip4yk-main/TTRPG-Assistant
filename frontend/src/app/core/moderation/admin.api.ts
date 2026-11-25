import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AdminPageDto,
  AdminRatingDto,
  AdminRatingFilter,
  AdminUserDto,
  AdminUserListItemDto,
  AppealDecisionInput,
  AppealDto,
  AssignableRole,
  ComplaintDto,
  ComplaintStatus,
  ModerationLogDto,
  OwnerTransferInput,
  SanctionAppealStatus,
  SanctionDto,
  SanctionInput,
} from '@nri/shared';

/** Query без порожніх значень. */
function params(values: Record<string, string | number | null | undefined>): HttpParams {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(values)) {
    if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
  }
  return p;
}

/**
 * Розділ «Адмінка» (`/api/admin/*`, лише персонал; права — на бекенді: 403
 * `MODERATION_FORBIDDEN`). Списки — сторінками з курсором (`nextCursor` = null — кінець).
 */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);

  complaints(
    status: ComplaintStatus | null,
    cursor?: number | null,
  ): Observable<AdminPageDto<ComplaintDto>> {
    return this.http.get<AdminPageDto<ComplaintDto>>('/api/admin/complaints', {
      params: params({ status, cursor }),
    });
  }

  dismissComplaint(id: number, note?: string): Observable<ComplaintDto> {
    return this.http.post<ComplaintDto>(`/api/admin/complaints/${id}/dismiss`, { note });
  }

  actionComplaint(id: number, sanction: SanctionInput): Observable<ComplaintDto> {
    return this.http.post<ComplaintDto>(`/api/admin/complaints/${id}/action`, { sanction });
  }

  users(q: string, cursor?: number | null): Observable<AdminPageDto<AdminUserListItemDto>> {
    return this.http.get<AdminPageDto<AdminUserListItemDto>>('/api/admin/users', {
      params: params({ q, cursor }),
    });
  }

  user(publicId: string): Observable<AdminUserDto> {
    return this.http.get<AdminUserDto>(`/api/admin/users/${encodeURIComponent(publicId)}`);
  }

  impose(publicId: string, input: SanctionInput): Observable<SanctionDto> {
    return this.http.post<SanctionDto>(
      `/api/admin/users/${encodeURIComponent(publicId)}/sanctions`,
      input,
    );
  }

  lift(sanctionId: number, note?: string): Observable<SanctionDto> {
    return this.http.post<SanctionDto>(`/api/admin/sanctions/${sanctionId}/lift`, { note });
  }

  setRole(publicId: string, role: AssignableRole): Observable<AdminUserDto> {
    return this.http.put<AdminUserDto>(`/api/admin/users/${encodeURIComponent(publicId)}/role`, {
      role,
    });
  }

  transferOwner(input: OwnerTransferInput): Observable<AdminUserDto> {
    return this.http.post<AdminUserDto>('/api/admin/owner/transfer', input);
  }

  appeals(
    status: SanctionAppealStatus | null,
    cursor?: number | null,
  ): Observable<AdminPageDto<AppealDto>> {
    return this.http.get<AdminPageDto<AppealDto>>('/api/admin/appeals', {
      params: params({ status, cursor }),
    });
  }

  decideAppeal(id: number, input: AppealDecisionInput): Observable<AppealDto> {
    return this.http.post<AppealDto>(`/api/admin/appeals/${id}/decide`, input);
  }

  ratings(
    filter: AdminRatingFilter,
    cursor?: number | null,
  ): Observable<AdminPageDto<AdminRatingDto>> {
    return this.http.get<AdminPageDto<AdminRatingDto>>('/api/admin/ratings', {
      params: params({ filter, cursor }),
    });
  }

  hideRatingText(id: number, reason: string): Observable<AdminRatingDto> {
    return this.http.post<AdminRatingDto>(`/api/admin/ratings/${id}/hide-text`, { reason });
  }

  cancelRating(id: number, reason: string): Observable<AdminRatingDto> {
    return this.http.post<AdminRatingDto>(`/api/admin/ratings/${id}/cancel`, { reason });
  }

  log(cursor?: number | null): Observable<AdminPageDto<ModerationLogDto>> {
    return this.http.get<AdminPageDto<ModerationLogDto>>('/api/admin/log', {
      params: params({ cursor }),
    });
  }
}
