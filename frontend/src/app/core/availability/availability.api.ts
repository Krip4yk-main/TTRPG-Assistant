import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AvailabilityDto, AvailabilityInput } from '@nri/shared';

/** Власний тижневий календар доступності (`/api/me/availability`). */
@Injectable({ providedIn: 'root' })
export class AvailabilityApi {
  private readonly http = inject(HttpClient);

  get(): Observable<AvailabilityDto> {
    return this.http.get<AvailabilityDto>('/api/me/availability');
  }

  /** Замінює календар повністю. Також змінює пояс акаунта на `input.timezone` (R5). */
  put(input: AvailabilityInput): Observable<AvailabilityDto> {
    return this.http.put<AvailabilityDto>('/api/me/availability', input);
  }
}
