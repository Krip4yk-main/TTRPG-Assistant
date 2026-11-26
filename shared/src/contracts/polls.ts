import { z } from 'zod';
import {
  dayNumber,
  fromDayNumber,
  toZoned,
  weekdayOf,
  zonedToUtc,
  type Weekday,
} from '../schedule/tz.js';

/**
 * Голосування за час (Plan 12 Task 2). `regular` — варіанти «день тижня + час» у поясі гри
 * (новий розклад кампейну); `one_off` — конкретні дати (перенесення сесії `sessionId` або,
 * без неї, нова разова сесія).
 */
export const POLL_KINDS = ['regular', 'one_off'] as const;
export type PollKind = (typeof POLL_KINDS)[number];

export const POLL_STATUSES = ['open', 'closed'] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

/** Чому закрито: проголосували всі активні учасники, настав дедлайн, закрив майстер. */
export const POLL_CLOSE_REASONS = ['all_voted', 'deadline', 'gm'] as const;
export type PollCloseReason = (typeof POLL_CLOSE_REASONS)[number];

/** «Можу / не можу / якщо треба». */
export const POLL_VOTE_VALUES = ['yes', 'no', 'maybe'] as const;
export type PollVoteValue = (typeof POLL_VOTE_VALUES)[number];

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
/** Дедлайн — не пізніше ніж через 14 днів від створення. */
export const POLL_MAX_DEADLINE_DAYS = 14;
/** Відкритих голосувань на гру одночасно (захист від спаму сповіщеннями). */
export const POLL_MAX_OPEN_PER_GAME = 3;

const MINUTE_MS = 60_000;

const instant = z.iso
  .datetime({ offset: true })
  .refine((s) => new Date(s).getTime() % MINUTE_MS === 0, 'Must be a whole minute')
  .transform((s) => new Date(s).toISOString());

/** Дедлайн — будь-який момент (секунди дозволено). */
const deadlineAt = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());

const regularOption = z
  .object({
    weekday: z.number().int().min(0).max(6),
    /** Хвилини від півночі в поясі гри. */
    startMin: z.number().int().min(0).max(1439),
  })
  .strict();

const oneOffOption = z.object({ startsAt: instant }).strict();

/**
 * Тіло `POST /api/games/:id/polls`. Варіанти — з підбору (`GET /api/games/:id/common-times`:
 * `regular[].weekday/startMin` чи `oneOff[].startsAt`) або вручну. Бекенд додатково перевіряє:
 * дедлайн у майбутньому й ≤ 14 днів, разові варіанти — у майбутньому, `regular` — лише
 * кампейн, `sessionId` — запланована сесія цієї гри.
 */
export const pollCreateSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('regular'),
        options: z.array(regularOption).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS),
        closesAt: deadlineAt,
      })
      .strict(),
    z
      .object({
        kind: z.literal('one_off'),
        options: z.array(oneOffOption).min(POLL_MIN_OPTIONS).max(POLL_MAX_OPTIONS),
        closesAt: deadlineAt,
        /** Перенесення конкретної сесії; без неї — нова разова сесія. */
        sessionId: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .superRefine((p, ctx) => {
    const keys = p.options.map((o) =>
      'startsAt' in o ? o.startsAt : `${o.weekday}:${o.startMin}`,
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Duplicate options' });
    }
  });
export type PollCreateInput = z.input<typeof pollCreateSchema>;

/** Тіло `PUT /api/polls/:id/votes`: відповіді на один чи кілька варіантів (решта не змінюється). */
export const pollVotesSchema = z
  .object({
    votes: z
      .array(
        z
          .object({
            optionId: z.number().int().positive(),
            value: z.enum(POLL_VOTE_VALUES),
          })
          .strict(),
      )
      .min(1)
      .max(POLL_MAX_OPTIONS),
  })
  .strict()
  .refine((b) => new Set(b.votes.map((v) => v.optionId)).size === b.votes.length, {
    message: 'Duplicate optionId',
    path: ['votes'],
  });
export type PollVotesInput = z.input<typeof pollVotesSchema>;

/** Тіло `POST /api/polls/:id/apply`: без `optionId` — переможець. */
export const pollApplySchema = z
  .object({ optionId: z.number().int().positive().optional() })
  .strict();
export type PollApplyInput = z.input<typeof pollApplySchema>;

export interface PollVoteDto {
  userId: number;
  value: PollVoteValue;
}

export interface PollOptionDto {
  id: number;
  /** Порядок 1…6 (номер на кнопках Telegram). */
  position: number;
  /** `regular`: день тижня й хвилини від півночі **в поясі гри**; `one_off` — `null`. */
  weekday: Weekday | null;
  startMin: number | null;
  /**
   * ISO UTC. `one_off` — сама сесія; `regular` — найближча сесія цього варіанта на момент
   * створення (для показу в поясі глядача).
   */
  startsAt: string;
  yes: number;
  no: number;
  maybe: number;
  /** Відповіді учасників (бачать майстер і активні учасники). */
  votes: PollVoteDto[];
}

export interface PollVoterDto {
  userId: number;
  nickname: string | null;
  /** Відповів на всі варіанти. */
  voted: boolean;
}

export interface PollDto {
  id: number;
  gameId: number;
  kind: PollKind;
  status: PollStatus;
  closeReason: PollCloseReason | null;
  /** Пояс гри (для `regular` `weekday/startMin`). */
  timezone: string;
  durationMinutes: number;
  /** Сесія, яку переносимо (`one_off`), або `null`. */
  sessionId: number | null;
  closesAt: string;
  createdAt: string;
  closedAt: string | null;
  options: PollOptionDto[];
  /** Активні учасники (без майстра) — хто голосує. */
  voters: PollVoterDto[];
  /**
   * Переможець: найбільше «можу», далі найменше «не можу», далі більше «якщо треба», далі
   * раніший варіант. Немає жодного «можу» чи «якщо треба» — `null`.
   */
  winnerOptionId: number | null;
  /** Застосовано майстром (розклад змінено / сесію перенесено чи створено). */
  appliedAt: string | null;
  appliedOptionId: number | null;
  /** Сесія, створена чи перенесена застосуванням разового варіанта. */
  appliedSessionId: number | null;
  /** Глядач — майстер гри. */
  isGm: boolean;
  /** Глядач може голосувати (активний учасник, голосування відкрите). */
  canVote: boolean;
}

/** Відповідь `POST /api/polls/:id/apply`. */
export interface PollApplyResultDto {
  poll: PollDto;
  /** `schedule` — нове правило розкладу кампейну; `session` — перенесено чи створено сесію. */
  applied: { kind: 'schedule' } | { kind: 'session'; sessionId: number };
}

type WinnerOption = Pick<PollOptionDto, 'id' | 'position' | 'yes' | 'no' | 'maybe'>;

/** Переможець голосування (див. `PollDto.winnerOptionId`). */
export function pollWinner(options: readonly WinnerOption[]): number | null {
  const ranked = [...options]
    .filter((o) => o.yes + o.maybe > 0)
    .sort((a, b) => b.yes - a.yes || a.no - b.no || b.maybe - a.maybe || a.position - b.position);
  return ranked[0]?.id ?? null;
}

/**
 * Найближчий строго після `after` початок «день тижня + час» у поясі `tz`. Локальний час, якого
 * не існує (весняний перехід), пропускається — береться наступний тиждень.
 */
export function nextWeeklyStart(tz: string, weekday: Weekday, startMin: number, after: Date): Date {
  const z = toZoned(after, tz);
  const today = dayNumber(z.year, z.month, z.day);
  const shift = (weekday - weekdayOf(z.year, z.month, z.day) + 7) % 7;
  const hour = Math.floor(startMin / 60);
  const minute = startMin % 60;
  for (let n = today + shift; n <= today + shift + 21; n += 7) {
    const date = fromDayNumber(n);
    const at = zonedToUtc({ ...date, hour, minute }, tz);
    const back = toZoned(at, tz);
    if (back.day !== date.day || back.hour !== hour || back.minute !== minute) continue;
    if (at > after) return at;
  }
  throw new Error('no weekly start found');
}
