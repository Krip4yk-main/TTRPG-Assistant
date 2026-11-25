import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { NoteDto, NoteUpdateInput, SharedNotesDto } from '@nri/shared';

/** Джерело однієї нотатки для `NoteEditor`: прочитати й зберегти з оптимістичним блокуванням. */
export interface NoteSource {
  /** Стабільний ключ нотатки (`game_private.7`) — для локальної копії незбереженого тексту. */
  key: string;
  /** URL `PUT` — для збереження з `keepalive` при закритті сторінки. */
  url: string;
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

  /** Власна сторінка спільної нотатки (лише гравцям). */
  sharedPage(gameId: number, load: () => Observable<NoteDto>): NoteSource {
    const url = `/api/games/${gameId}/notes/shared`;
    return {
      key: `game_shared.${gameId}`,
      url,
      load,
      save: (input) => this.http.put<NoteDto>(url, input),
    };
  }

  /** Приватна нотатка на гру (майстер і активні учасники). */
  gamePrivate(gameId: number): NoteSource {
    const url = `/api/games/${gameId}/notes/private`;
    return {
      key: `game_private.${gameId}`,
      url,
      load: () => this.http.get<NoteDto>(url),
      save: (input) => this.http.put<NoteDto>(url, input),
    };
  }

  /** Приватна нотатка на сесію (майстер і активні учасники гри). */
  sessionPrivate(sessionId: number): NoteSource {
    const url = `/api/sessions/${sessionId}/notes/private`;
    return {
      key: `session_private.${sessionId}`,
      url,
      load: () => this.http.get<NoteDto>(url),
      save: (input) => this.http.put<NoteDto>(url, input),
    };
  }
}
