import { z } from 'zod';
import type { GameCardDto, GameGmDto, RestrictedGameDto } from './games.js';
import type { SeenState } from './views.js';

export const APPLICATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'cancelled',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Причина автоматичного скасування `pending`-заявки. */
export const APPLICATION_CANCEL_REASONS = [
  'age_rating',
  'game_cancelled',
  'game_finished',
  'banned',
] as const;
export type ApplicationCancelReason = (typeof APPLICATION_CANCEL_REASONS)[number];

/** Відповідь майстра на обмеження гравця. */
export const CONSTRAINT_RESPONSES = ['accepted', 'partial', 'cannot_guarantee'] as const;
export type ConstraintResponse = (typeof CONSTRAINT_RESPONSES)[number];

export const APPLICATION_MESSAGE_MAX = 1000;
export const APPLICATION_ANSWER_MAX = 1000;
export const APPLICATION_CONSTRAINTS_MAX = 10;
export const APPLICATION_CONSTRAINT_MAX = 200;
export const CONSTRAINT_COMMENT_MAX = 500;

/**
 * Тіло `POST /api/games/:id/applications`. Обов'язковість погодження й відповідей
 * залежить від гри — перевіряє сервіс (`WARNINGS_NOT_ACCEPTED`, `ANSWERS_REQUIRED`).
 */
export const applicationInputSchema = z
  .object({
    warningsAccepted: z.boolean(),
    answers: z.array(z.string().trim().max(APPLICATION_ANSWER_MAX)).max(10),
    message: z
      .string()
      .trim()
      .max(APPLICATION_MESSAGE_MAX)
      .nullish()
      .transform((s) => (s ? s : null)),
    constraints: z
      .array(z.string().trim().min(1).max(APPLICATION_CONSTRAINT_MAX))
      .max(APPLICATION_CONSTRAINTS_MAX)
      .default([]),
  })
  .strict();
export type ApplicationInput = z.input<typeof applicationInputSchema>;

/** Тіло `PUT /api/applications/:id/constraints/:constraintId`. */
export const constraintResponseInputSchema = z
  .object({
    response: z.enum(CONSTRAINT_RESPONSES),
    comment: z
      .string()
      .trim()
      .max(CONSTRAINT_COMMENT_MAX)
      .nullish()
      .transform((s) => (s ? s : null)),
  })
  .strict()
  .refine((v) => v.response !== 'partial' || v.comment !== null, {
    path: ['comment'],
    message: 'partial requires a comment',
  });
export type ConstraintResponseInput = z.input<typeof constraintResponseInputSchema>;

/** Обмеження гравця з відповіддю майстра (`null` — ще не відповів). */
export interface ApplicationConstraintDto {
  id: string;
  text: string;
  response: ConstraintResponse | null;
  comment: string | null;
}

export interface ApplicationDto {
  id: number;
  gameId: number;
  status: ApplicationStatus;
  message: string | null;
  answers: string[];
  constraints: ApplicationConstraintDto[];
  cancelReason: ApplicationCancelReason | null;
  createdAt: string;
  decidedAt: string | null;
}

/** `GET /api/me/applications`: картка гри — через ті самі вікові правила (`toCardView`). */
export interface MyApplicationDto extends ApplicationDto {
  game: GameCardDto | RestrictedGameDto;
  /** Стан перегляду заявки її автором. */
  seen: SeenState;
}

/** `GET /api/games/:id/applications` (майстер): вік заявника не розкривається. */
export interface GameApplicationDto extends ApplicationDto {
  applicant: GameGmDto;
  meetsAgeRating: boolean;
  /** Стан перегляду заявки майстром. */
  seen: SeenState;
}
