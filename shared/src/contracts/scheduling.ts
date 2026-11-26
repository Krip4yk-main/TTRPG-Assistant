import { z } from 'zod';
import type { Weekday } from '../schedule/tz.js';
import { isoDate } from '../schemas/common.js';

/** Підбір спільного часу: горизонт у тижнях за замовчуванням і межі. */
export const COMMON_TIMES_DEFAULT_WEEKS = 4;
export const COMMON_TIMES_MAX_WEEKS = 8;
/** Скільки кандидатів кожного виду повертає `GET /api/games/:id/common-times`. */
export const COMMON_TIMES_TOP = 5;
/** Крок сітки кандидатів (хв, у поясі гри). */
export const COMMON_TIMES_STEP_MINUTES = 30;

/**
 * Статус учасника для кандидата: `unknown` — у нього немає календаря (ні тижневих слотів,
 * ні імпортованої зайнятості) і відомих конфліктів теж немає. `unknown` ніколи не
 * рахується як «може».
 */
export type CommonTimeStatus = 'can' | 'cannot' | 'unknown';

export interface CommonTimesParticipantDto {
  userId: number;
  nickname: string | null;
  isGm: boolean;
  /** Є тижневі слоти або імпортований календар; інакше статус зазвичай `unknown`. */
  hasCalendar: boolean;
}

interface CandidateCounts {
  can: number;
  cannot: number;
  unknown: number;
}

/**
 * Статус учасника для регулярного кандидата — за більшістю тижнів горизонту: `can` — може
 * на > половині сесій; `cannot` — не може на ≥ половині; `unknown` — немає календаря і
 * відомі конфлікти (сесії інших ігор, зайняті дати) — меншість тижнів.
 */
export interface RegularCandidateStatusDto {
  userId: number;
  status: CommonTimeStatus;
  /** Скільки з `weeks` сесій учасник може (решта — не може або невідомо). */
  weeksCan: number;
  /**
   * Скільки з `weeks` сесій виходять за тижневі слоти учасника — зазвичай тижні, коли зсув
   * DST між поясами (або ніч переходу) зсуває сесію відносно його слотів.
   */
  outsideSlotsWeeks: number;
}

/**
 * «Регулярний» кандидат: день тижня й локальний час **у поясі гри**. Оцінено кожну конкретну
 * сесію горизонту окремо (DST, пояси учасників); `weeks` — скільки сесій у горизонті.
 */
export interface RegularCandidateDto extends CandidateCounts {
  weekday: Weekday;
  /** Хвилини від півночі в поясі гри (кратні 30). */
  startMin: number;
  weeks: number;
  /** Перша сесія цього кандидата в горизонті, ISO UTC. */
  firstStartsAt: string;
  statuses: RegularCandidateStatusDto[];
}

export interface OneOffCandidateStatusDto {
  userId: number;
  status: CommonTimeStatus;
}

/** «Разовий» кандидат: конкретна сесія. */
export interface OneOffCandidateDto extends CandidateCounts {
  /** ISO UTC. */
  startsAt: string;
  endsAt: string;
  statuses: OneOffCandidateStatusDto[];
}

export interface CommonTimesDto {
  /** Пояс гри: у ньому задано `weekday`/`startMin` регулярних кандидатів. */
  timezone: string;
  durationMinutes: number;
  /** Вікно пошуку `[from, to)`, ISO UTC. */
  from: string;
  to: string;
  participants: CommonTimesParticipantDto[];
  /**
   * Ні в кого з учасників немає календаря (`participants[].hasCalendar` усі `false`) — тоді
   * списки кандидатів порожні: варто попросити групу заповнити календарі.
   */
  noCalendars: boolean;
  /** Для разових ігор (oneshot) — завжди `[]`. */
  regular: RegularCandidateDto[];
  oneOff: OneOffCandidateDto[];
}

/**
 * Query `GET /api/games/:id/common-times`: `weeks` (1–8, за замовчуванням 4) — горизонт від
 * «зараз»; `weekOf` (`YYYY-MM-DD`) — натомість один тиждень (пн–нд у поясі гри), що містить
 * цю дату (розумне перенесення). Обидва разом — 400.
 */
export const commonTimesQuerySchema = z
  .object({
    weeks: z.coerce.number().int().min(1).max(COMMON_TIMES_MAX_WEEKS).optional(),
    weekOf: isoDate.optional(),
  })
  .strict()
  .refine((v) => !(v.weeks !== undefined && v.weekOf !== undefined), {
    message: 'weeks and weekOf are mutually exclusive',
    path: ['weekOf'],
  });

export type CommonTimesQuery = z.infer<typeof commonTimesQuerySchema>;
