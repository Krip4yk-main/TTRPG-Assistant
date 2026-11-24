import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AvailabilityDto } from '@nri/shared';

/** Власний тижневий календар доступності (`/api/me/availability`). */
@Injectable({ providedIn: 'root' })
export class AvailabilityApi {
  private readonly http = inject(HttpClient);

  get(): Observable<AvailabilityDto> {
    return this.http.get<AvailabilityDto>('/api/me/availability');
  }
}
