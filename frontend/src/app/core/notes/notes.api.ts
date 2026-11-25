import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { NoteDto, NoteUpdateInput, SharedNotesDto } from '@nri/shared';

/** Джерело однієї нотатки для `NoteEditor`: прочитати й зберегти з оптимістичним блокуванням. */
export interface NoteSource {
  load(): Observable<NoteDto>;
  save(input: NoteUpdateInput): Observable<NoteDto>;
}

/**
 * Нотатки гри й сесії. `PUT` з застарілою `version` → 409 `NOTE_CONFLICT`
 * з актуальними `{ body, version }` у `details`.
 */
@Injectable({ providedIn: 'root' })
export class NotesApi {
  private readonly http = inject(HttpClient);

  /** Спільна нотатка гравців: сторінки всіх гравців (майстру — 403). */
  shared(gameId: number): Observable<SharedNotesDto> {
    return this.http.get<SharedNotesDto>(`/api/games/${gameId}/notes/shared`);
  }

  /** Зберегти власну сторінку спільної нотатки. */
  saveShared(gameId: number, input: NoteUpdateInput): Observable<NoteDto> {
    return this.http.put<NoteDto>(`/api/games/${gameId}/notes/shared`, input);
  }

  /** Приватна нотатка на гру (майстер і активні учасники). */
  gamePrivate(gameId: number): NoteSource {
    const url = `/api/games/${gameId}/notes/private`;
    return {
      load: () => this.http.get<NoteDto>(url),
      save: (input) => this.http.put<NoteDto>(url, input),
    };
  }

  /** Приватна нотатка на сесію (майстер і активні учасники гри). */
  sessionPrivate(sessionId: number): NoteSource {
    const url = `/api/sessions/${sessionId}/notes/private`;
    return {
      load: () => this.http.get<NoteDto>(url),
      save: (input) => this.http.put<NoteDto>(url, input),
    };
  }
}
