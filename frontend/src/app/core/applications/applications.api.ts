import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { ApplicationDto, ApplicationInput, MyApplicationDto } from '@nri/shared';

/** Тонкий шар над HTTP API заявок гравця. */
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
}
