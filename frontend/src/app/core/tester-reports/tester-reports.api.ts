import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AdminPageDto,
  TesterReportCreatedDto,
  TesterReportDto,
  TesterReportInput,
  TesterReportStatus,
} from '@nri/shared';

/**
 * Звіти тестувальників (лише dev-сервер; поза ним бекенд відповідає 404): подання — будь-хто,
 * зокрема гість; список і позначка «Опрацьовано» — адмін і власник.
 */
@Injectable({ providedIn: 'root' })
export class TesterReportsApi {
  private readonly http = inject(HttpClient);

  submit(input: TesterReportInput): Observable<TesterReportCreatedDto> {
    return this.http.post<TesterReportCreatedDto>('/api/tester-reports', input);
  }

  list(
    status: TesterReportStatus | null,
    cursor?: number | null,
  ): Observable<AdminPageDto<TesterReportDto>> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    if (cursor) params = params.set('cursor', String(cursor));
    return this.http.get<AdminPageDto<TesterReportDto>>('/api/admin/tester-reports', { params });
  }

  markProcessed(id: number): Observable<TesterReportDto> {
    return this.http.post<TesterReportDto>(`/api/admin/tester-reports/${id}/processed`, {});
  }
}
