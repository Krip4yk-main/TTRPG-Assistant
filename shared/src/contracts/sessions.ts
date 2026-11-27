import { z } from 'zod';
import type { SeenState } from './views.js';
import { startWindowMinutesSchema, windowEnd } from './games.js';
import type { OneOffCandidateDto, CommonTimesParticipantDto } from './scheduling.js';

export const SESSION_STATUSES = ['scheduled', 'done', 'cancelled'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** `rule` — з правила розкладу гри, `manual` — додана вручну. */
export const SESSION_ORIGINS = ['rule', 'manual'] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/** Сесії матеріалізуються на 4 тижні вперед (рішення власника). */
export const SESSION_WINDOW_DAYS = 28;

/** RSVP на майбутню сесію: «буду» / «не зможу». */
export const RSVP_STATUSES = ['going', 'not_going'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

/** Тіло `PUT /api/sessions/:id/rsvp`. */
export const rsvpInputSchema = z.object({ status: z.enum(RSVP_STATUSES) }).strict();
export type RsvpInput = z.input<typeof rsvpInputSchema>;

/** Зведення RSVP — лише майстру. `members` — усі активні учасники (`status: null` — не відповів). */
export interface SessionRsvpSummary {
  going: number;
  notGoing: number;
  members: { publicId: string; nickname: string; status: RsvpStatus | null }[];
}

export const SESSION_CANCEL_REASON_MAX = 300;
export const SESSION_SUMMARY_MAX = 10_000;
/** Скільки символів підсумку йде в сповіщення `session.summary` (далі — «…»). */
export const SESSION_SUMMARY_EXCERPT = 300;

/**
 * Початок підсумку для сповіщення: до `SESSION_SUMMARY_EXCERPT` символів (кодових точок — емодзі
 * не розрізаються), довший — обрізаний по межі слова, якщо вона недалеко, і з «…».
 */
export function summaryExcerpt(summary: string, max = SESSION_SUMMARY_EXCERPT): string {
  const text = summary.trim();
  const chars = [...text];
  if (chars.length <= max) return text;
  let cut = chars.slice(0, max).join('');
  const space = cut.search(/\s\S*$/);
  if (space > max * 0.7) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

const summaryText = z
  .string()
  .trim()
  .max(SESSION_SUMMARY_MAX)
  .nullish()
  .transform((s) => (s ? s : null));

const MINUTE_MS = 60_000;

const startsAt = z.iso
  .datetime({ offset: true })
  .refine((s) => new Date(s).getTime() % MINUTE_MS === 0, 'startsAt must be a whole minute')
  .transform((s) => new Date(s).toISOString());

const durationMinutes = z.number().int().min(30).max(720).multipleOf(30);

/**
 * Тіло `POST /api/sessions/:id/reschedule`. `startWindowMinutes` — вікно початку від `startsAt`
 * (`null` — точний час; без поля — лишається поточне). «Уточнити час» сесії з вікном —
 * перенесення на точний `startsAt` з `startWindowMinutes: null`.
 */
export const rescheduleSessionInputSchema = z
  .object({
    startsAt,
    durationMinutes: durationMinutes.optional(),
    startWindowMinutes: startWindowMinutesSchema.optional(),
  })
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
    summary: summaryText,
    /** Одразу надіслати підсумок учасникам (як `POST /api/sessions/:id/summary/send`). */
    sendSummary: z.boolean().optional(),
  })
  .strict();
export type FinishSessionInput = z.input<typeof finishSessionInputSchema>;

/** Тіло `PUT /api/sessions/:id/summary` — підсумок проведеної сесії; порожній — прибрати. */
export const sessionSummaryInputSchema = z.object({ summary: summaryText }).strict();
export type SessionSummaryInput = z.input<typeof sessionSummaryInputSchema>;

export interface SessionDto {
  id: number;
  gameId: number;
  startsAt: string;
  durationMinutes: number;
  /**
   * Приблизний час: сесія почнеться між `startsAt` і `startsAt` + стільки хвилин; `null` —
   * точний час (див. `START_WINDOW_MIN`).
   */
  startWindowMinutes: number | null;
  status: SessionStatus;
  origin: SessionOrigin;
  rescheduled: boolean;
  cancelReason: string | null;
  /** Лише для майстра й активних учасників. */
  summary: string | null;
  /** Коли підсумок надіслано учасникам (один раз); `null` — ще ні. */
  summarySentAt: string | null;
  doneAt: string | null;
  /** Моя відповідь (активний учасник); для майстра й без відповіді — `null`. */
  myRsvp: RsvpStatus | null;
  /** Лише в DTO майстра (приватність учасників); іншим — `null`. */
  rsvpSummary: SessionRsvpSummary | null;
  /** Стан перегляду сесії глядачем (майстер чи активний учасник). */
  seen: SeenState;
  /**
   * X-Card увімкнена майстром у цій грі, а глядач — не майстер (DTO сесії бачать лише майстер
   * і активні учасники, тож це «глядач — учасник»). Чи зараз вікно (`xCardWindow`),
   * перевіряє клієнт за годинником.
   */
  xCard: boolean;
}

/** X-Card можна підняти за стільки хвилин до початку сесії і стільки ж після її кінця. */
export const X_CARD_MARGIN_MINUTES = 30;
/** Ліміт X-Card: одне натискання на користувача на сесію за стільки секунд. */
export const X_CARD_COOLDOWN_SEC = 300;

/**
 * Вікно X-Card (`POST /api/sessions/:id/x-card`): від `startsAt − 30 хв` до кінця сесії
 * (`windowEnd` + тривалість) `+ 30 хв`, обидві межі включно.
 */
export function xCardWindow(s: {
  startsAt: Date;
  startWindowMinutes: number | null;
  durationMinutes: number;
}): { from: Date; to: Date } {
  const margin = X_CARD_MARGIN_MINUTES * 60_000;
  const end = windowEnd(s.startsAt, s.startWindowMinutes).getTime() + s.durationMinutes * 60_000;
  return { from: new Date(s.startsAt.getTime() - margin), to: new Date(end + margin) };
}

/**
 * `GET /api/sessions/:id/window-slots` (лише майстер гри, сесія `scheduled`): підказка, коли
 * саме почати сесію з приблизним часом. Для кожного 30-хв старту у вікні (від `startsAt` до
 * `startsAt` + `startWindowMinutes` включно, лише в майбутньому; без вікна — один старт)
 * — хто з учасників може на всю тривалість сесії, хто ні, про кого невідомо (той самий
 * підбір, що й у спільному часі). Нічого не змінює — уточнює час майстер перенесенням.
 */
export interface SessionWindowSlotsDto {
  sessionId: number;
  /** Початок вікна (ISO UTC). */
  startsAt: string;
  startWindowMinutes: number | null;
  timezone: string;
  durationMinutes: number;
  participants: CommonTimesParticipantDto[];
  noCalendars: boolean;
  /** У хронологічному порядку; `statuses` — у порядку `participants`. */
  slots: OneOffCandidateDto[];
}
