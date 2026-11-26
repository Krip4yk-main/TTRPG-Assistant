import { z } from 'zod';
import type { GameStatus } from './games.js';
import { ADMIN_PAGE_DEFAULT, ADMIN_PAGE_MAX, type ModerationUserRefDto } from './moderation.js';

/**
 * «Мертві» ігри (План 7). Перевіряються ігри в статусах `recruiting`/`started`; «проведена»
 * сесія — `done`. Відлік — пізніше з: остання проведена сесія, публікація, перша не скасована
 * сесія гри, відновлення кампейну з паузи.
 */
const DAY_MS = 86_400_000;
/** Більше стількох днів без проведеної сесії — нагадування майстру. */
export const STALE_REMIND_DAYS = 30;
/** Більше стількох днів — гра «мертва» (прихована з пошуку, блок створення ігор). */
export const STALE_DEAD_DAYS = 90;
/** «Все ок» від майстра: нагадування й позначка повертаються не раніше ніж через 14 днів. */
export const STALE_SNOOZE_DAYS = 14;
/** Накладання: вікно, за яке рахуються перетини сесій двох ігор майстра. */
export const OVERLAP_WINDOW_DAYS = 28;
/** Накладання: щонайменше стільки перетинів за вікно — обидві ігри «підозрілі». */
export const OVERLAP_MIN_INTERSECTIONS = 3;
/** Адмін зняв «підозрілу»: позначка не повертається 4 тижні. */
export const SUSPICIOUS_DISMISS_DAYS = 28;

/** Кампейн на паузі довше за стільки днів — нагадування майстру (`game.long_pause`). */
export const LONG_PAUSE_REMIND_DAYS = 90;
/** Повтор нагадування про довгу паузу — не частіше ніж раз на стільки днів. */
export const LONG_PAUSE_REPEAT_DAYS = 30;

export const STALE_REMIND_MS = STALE_REMIND_DAYS * DAY_MS;
export const LONG_PAUSE_REMIND_MS = LONG_PAUSE_REMIND_DAYS * DAY_MS;
export const LONG_PAUSE_REPEAT_MS = LONG_PAUSE_REPEAT_DAYS * DAY_MS;
export const STALE_DEAD_MS = STALE_DEAD_DAYS * DAY_MS;

/**
 * Стан гри для майстра: `ok`; `stale` — давно не проводилась (нагадування); `dead` —
 * позначена «мертвою».
 */
export const STALENESS_STATES = ['ok', 'stale', 'dead'] as const;
export type StalenessState = (typeof STALENESS_STATES)[number];

/** Гра майстра з позначкою (`GET /api/me/dead-games`). */
export interface MyDeadGameDto {
  id: number;
  title: string;
  status: GameStatus;
  state: StalenessState;
  suspicious: boolean;
  /** Від чого рахується давність (ISO UTC); `null` — немає з чого рахувати. */
  lastActivityAt: string | null;
  deadAt: string | null;
  suspiciousAt: string | null;
}

/**
 * `GET /api/me/dead-games`: ігри майстра зі станом `stale`/`dead` або «підозрілі».
 * `deadGameIds` — ті, що блокують створення нової гри (як у `GAME_CREATION_BLOCKED`).
 */
export interface MyDeadGamesDto {
  items: MyDeadGameDto[];
  deadGameIds: number[];
}

/** Деталі 409 `GAME_CREATION_BLOCKED` (`error.details`). */
export interface GameCreationBlockedDetails {
  deadGameIds: number[];
}

export const DEAD_GAME_KINDS = ['dead', 'suspicious'] as const;
export type DeadGameKind = (typeof DEAD_GAME_KINDS)[number];

/** Рядок вкладки адмінки «Мертві ігри». */
export interface AdminDeadGameDto {
  id: number;
  title: string;
  status: GameStatus;
  gm: ModerationUserRefDto;
  publishedAt: string | null;
  lastActivityAt: string | null;
  deadAt: string | null;
  suspiciousAt: string | null;
}

const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

/** Query `GET /api/admin/dead-games`: новіші позначки першими (курсор — id гри). */
export const adminDeadGamesQuerySchema = z.object({
  kind: z.preprocess(emptyAsUndefined, z.enum(DEAD_GAME_KINDS).default('dead')),
  cursor: z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().optional()),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX).default(ADMIN_PAGE_DEFAULT),
});
export type AdminDeadGamesQuery = z.input<typeof adminDeadGamesQuerySchema>;

/** `POST /api/admin/dead-games/:id/close`: необов'язкова примітка для журналу. */
export const adminDeadGameCloseSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type AdminDeadGameCloseInput = z.input<typeof adminDeadGameCloseSchema>;

/** `POST /api/admin/dead-games/:id/dismiss`: яку позначку зняти. */
export const adminDeadGameDismissSchema = z
  .object({ kind: z.enum(DEAD_GAME_KINDS), reason: z.string().trim().max(500).optional() })
  .strict();
export type AdminDeadGameDismissInput = z.input<typeof adminDeadGameDismissSchema>;
