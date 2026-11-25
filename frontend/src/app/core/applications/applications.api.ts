import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ApplicationDto,
  ApplicationInput,
  ConstraintResponseInput,
  GameApplicationDto,
  MyApplicationDto,
} from '@nri/shared';

/** Тонкий шар над HTTP API заявок (гравця й майстра). */
@Injectable({ providedIn: 'root' })
export class ApplicationsApi {
  private readonly http = inject(HttpClient);

  apply(gameId: number, input: ApplicationInput): Observable<ApplicationDto> {
    return this.http.post<ApplicationDto>(`/api/games/${gameId}/applications`, input);
  }

  /** Відкликати власну `pending`-заявку. */
  withdraw(id: number): Observable<ApplicationDto> {
    return this.http.delete<ApplicationDto>(`/api/applications/${id}`);
  }

  mine(): Observable<MyApplicationDto[]> {
    return this.http.get<MyApplicationDto[]>('/api/me/applications');
  }

  /** Заявки на гру — лише майстру. */
  forGame(gameId: number): Observable<GameApplicationDto[]> {
    return this.http.get<GameApplicationDto[]>(`/api/games/${gameId}/applications`);
  }

  approve(id: number): Observable<ApplicationDto> {
    return this.http.post<ApplicationDto>(`/api/applications/${id}/approve`, {});
  }

  reject(id: number): Observable<ApplicationDto> {
    return this.http.post<ApplicationDto>(`/api/applications/${id}/reject`, {});
  }

  /** Відповідь майстра на обмеження гравця (до й після затвердження). */
  respond(
    id: number,
    constraintId: string,
    input: ConstraintResponseInput,
  ): Observable<ApplicationDto> {
    return this.http.put<ApplicationDto>(
      `/api/applications/${id}/constraints/${constraintId}`,
      input,
    );
  }
}
