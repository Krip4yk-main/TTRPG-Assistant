import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { ProfileDto, ProfileInput, PublicProfileDto } from '@nri/shared';

/** Профілі: власний (`/api/me/profile`) і публічні (`/api/users/:publicId`). */
@Injectable({ providedIn: 'root' })
export class ProfileApi {
  private readonly http = inject(HttpClient);

  getPublic(publicId: string): Observable<PublicProfileDto> {
    return this.http.get<PublicProfileDto>(`/api/users/${encodeURIComponent(publicId)}`);
  }

  getMine(): Observable<ProfileDto> {
    return this.http.get<ProfileDto>('/api/me/profile');
  }

  /** Часткове оновлення; `privacy` зливається по ключах. */
  update(patch: ProfileInput): Observable<ProfileDto> {
    return this.http.patch<ProfileDto>('/api/me/profile', patch);
  }
}
