import { z } from 'zod';

export const SESSION_STATUSES = ['scheduled', 'done', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** `rule` — з правила розкладу гри, `manual` — додана вручну. */
export const SESSION_ORIGINS = ['rule', 'manual'] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/** Сесії матеріалізуються на 4 тижні вперед (рішення власника). */
export const SESSION_WINDOW_DAYS = 28;

export const SESSION_CANCEL_REASON_MAX = 300;
export const SESSION_SUMMARY_MAX = 10_000;

const MINUTE_MS = 60_000;

const startsAt = z.iso
  .datetime({ offset: true })
  .refine((s) => new Date(s).getTime() % MINUTE_MS === 0, 'startsAt must be a whole minute')
  .transform((s) => new Date(s).toISOString());

const durationMinutes = z.number().int().min(30).max(720).multipleOf(30);

/** Тіло `POST /api/sessions/:id/reschedule`. */
export const rescheduleSessionInputSchema = z
  .object({ startsAt, durationMinutes: durationMinutes.optional() })
  .strict();
export type RescheduleSessionInput = z.input<typeof rescheduleSessionInputSchema>;

/** Тіло `POST /api/sessions/:id/cancel`. */
export const cancelSessionInputSchema = z
  .object({ reason: z.string().trim().min(1).max(SESSION_CANCEL_REASON_MAX) })
  .strict();
export type CancelSessionInput = z.input<typeof cancelSessionInputSchema>;

/** Тіло `POST /api/sessions/:id/finish`. */
export const finishSessionInputSchema = z
  .object({
    attendance: z
      .array(z.object({ publicId: z.string().min(1).max(10), present: z.boolean() }).strict())
      .max(50)
      .refine((a) => new Set(a.map((x) => x.publicId)).size === a.length, 'duplicate publicId'),
    summary: z
      .string()
      .trim()
      .max(SESSION_SUMMARY_MAX)
      .nullish()
      .transform((s) => (s ? s : null)),
  })
  .strict();
export type FinishSessionInput = z.input<typeof finishSessionInputSchema>;

export interface SessionDto {
  id: number;
  gameId: number;
  startsAt: string;
  durationMinutes: number;
  status: SessionStatus;
  origin: SessionOrigin;
  rescheduled: boolean;
  cancelReason: string | null;
  /** Лише для майстра й активних учасників. */
  summary: string | null;
  doneAt: string | null;
}
