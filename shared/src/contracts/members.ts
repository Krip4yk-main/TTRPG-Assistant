import { z } from 'zod';
import type { GameDto } from './games.js';

export const MEMBER_ROLES = ['player'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Чому членство завершилось (`left_at` встановлено). */
export const MEMBER_LEFT_REASONS = ['left', 'kicked', 'banned'] as const;
export type MemberLeftReason = (typeof MEMBER_LEFT_REASONS)[number];

export const LEAVE_NOTE_MIN = 10;
export const LEAVE_NOTE_MAX = 2000;

/**
 * Тіло `POST /api/games/:id/leave`. Порожнє «для адміністрації» заповнюється
 * текстом «для майстра» (рішення власника).
 */
export const leaveGameInputSchema = z
  .object({
    noteForGm: z.string().trim().min(LEAVE_NOTE_MIN).max(LEAVE_NOTE_MAX),
    noteForAdmin: z.string().trim().max(LEAVE_NOTE_MAX).nullish(),
  })
  .strict()
  .transform((v) => ({ noteForGm: v.noteForGm, noteForAdmin: v.noteForAdmin || v.noteForGm }));
export type LeaveGameInput = z.input<typeof leaveGameInputSchema>;

/** Учасник гри (`GET /api/games/:id/members`). */
export interface MemberDto {
  publicId: string;
  nickname: string | null;
  avatarUrl: string | null;
  joinedAt: string;
}

/** Запис чорного списку майстра (`GET /api/me/blacklist`). */
export interface BlacklistEntryDto {
  publicId: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/** Попередження у відповіді на `POST /api/games/:id/start`. */
export const START_WARNINGS = ['BELOW_MIN_PLAYERS'] as const;
export type StartWarning = (typeof START_WARNINGS)[number];

/** Відповідь `POST /api/games/:id/{publish,start,finish,cancel}`: гра майстра + попередження. */
export type GameTransitionDto = GameDto & { warning?: StartWarning };
