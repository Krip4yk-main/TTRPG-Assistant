import { z } from 'zod';
import type { GameGmDto } from './games.js';

/**
 * `game_shared` — сторінка гравця у спільній нотатці (не видно майстру);
 * `game_private` / `session_private` — приватні нотатки учасника чи майстра.
 */
export const NOTE_SCOPES = ['game_shared', 'game_private', 'session_private'] as const;
export type NoteScope = (typeof NOTE_SCOPES)[number];

/** Рішення власника: ≤ 200 000 символів простого тексту. */
export const NOTE_BODY_MAX = 200_000;

/** Тіло `PUT …/notes/…`; `version` — та, що бачив клієнт (0 — нотатки ще немає). */
export const noteUpdateSchema = z
  .object({
    body: z.string().max(NOTE_BODY_MAX),
    version: z.number().int().min(0),
  })
  .strict();
export type NoteUpdateInput = z.input<typeof noteUpdateSchema>;

export interface NoteDto {
  body: string;
  /** 0 — нотатки ще немає. */
  version: number;
  updatedAt: string | null;
}

/** `details` помилки `NOTE_CONFLICT` — актуальний стан. */
export type NoteConflictDetails = Pick<NoteDto, 'body' | 'version'>;

export interface SharedNotePageDto extends NoteDto {
  author: GameGmDto;
  formerMember: boolean;
}

export interface SharedNotesDto {
  pages: SharedNotePageDto[];
}
