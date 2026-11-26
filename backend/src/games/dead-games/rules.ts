import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  OVERLAP_MIN_INTERSECTIONS,
  OVERLAP_WINDOW_DAYS,
  STALE_DEAD_MS,
  STALE_REMIND_MS,
  type GameStatus,
  type StalenessState,
} from '@nri/shared';
import type { Tx } from '../../applications/applications.rules.js';
import type { Db } from '../../db/client.js';
import { gameSessions, games } from '../../db/schema/index.js';

/**
 * Правила детектора «мертвих» ігор — окремі підключувані функції (`staleRule` — чиста,
 * `overlapRule` — запит), щоб додавати нові евристики без зміни детектора.
 */

const DAY_MS = 86_400_000;
type DbLike = Db | Tx;

/** Оновлення стану без зміни `updated_at`: позначки детектора — не «оновлення» гри для глядачів. */
export const keepUpdatedAt = { updatedAt: sql`${games.updatedAt}` };

/** Ігри, які перевіряє детектор. */
export const CHECKED_STATUSES = ['recruiting', 'started'] as const satisfies GameStatus[];

export const isChecked = (status: GameStatus): boolean =>
  (CHECKED_STATUSES as readonly GameStatus[]).includes(status);

/** Дані гри для `staleRule`. */
export interface StaleInput {
  status: GameStatus;
  publishedAt: Date | null;
  /** Остання проведена (`done`) сесія — її `done_at`. */
  lastDoneAt: Date | null;
  /** Перша сесія гри (`starts_at`; без майбутніх скасованих); без сесій — перший слот правила. */
  firstSessionAt: Date | null;
  /** Останнє відновлення кампейну з паузи (`resumed_at`); не відновлювався — `null`. */
  resumedAt?: Date | null;
  deadSnoozedUntil: Date | null;
  deadExemptUntilSession: boolean;
}

export type StaleVerdict = 'ok' | 'remind' | 'dead';

/**
 * Від чого рахується давність: пізніше з останньої проведеної сесії, публікації, першої
 * сесії (гра, що стартує через 3 місяці, не «мертва») і відновлення з паузи (кампейн після
 * довгої паузи не «мертвий» одразу). `null` — немає жодної дати.
 */
export function staleAnchor(
  g: Pick<StaleInput, 'publishedAt' | 'lastDoneAt' | 'firstSessionAt' | 'resumedAt'>,
) {
  const times = [g.lastDoneAt, g.publishedAt, g.firstSessionAt, g.resumedAt ?? null]
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Давність гри на момент `now`: більше 30 днів від відліку — `remind`, більше 90 — `dead`.
 * Не перевіряються: статуси, крім `recruiting`/`started`; звільнені адміном до наступної
 * проведеної сесії; «все ок» від майстра, доки не минуло `dead_snoozed_until`.
 */
export function staleRule(g: StaleInput, now: Date): StaleVerdict {
  if (!isChecked(g.status) || g.deadExemptUntilSession) return 'ok';
  if (g.deadSnoozedUntil && now < g.deadSnoozedUntil) return 'ok';
  const anchor = staleAnchor(g);
  if (!anchor) return 'ok';
  const age = now.getTime() - anchor.getTime();
  if (age > STALE_DEAD_MS) return 'dead';
  if (age > STALE_REMIND_MS) return 'remind';
  return 'ok';
}

/** Агрегати повертаються рядками 'YYYY-MM-DD HH:MM:SS[.fff]' (UTC, див. db/client.ts). */
const asDate = (v: string | Date | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(`${v.replace(' ', 'T')}Z`);

type Anchors = { lastDoneAt: Date | null; firstSessionAt: Date | null };

/**
 * Агрегати сесій гри: остання проведена (`done_at`) і перша сесія (`starts_at`). Скасовані
 * сесії в майбутньому не рахуються (гра ще не почалась), а в минулому — рахуються: інакше
 * скасування всіх минулих сесій зсунуло б відлік на наступну заплановану і гра ніколи не
 * стала б «мертвою».
 */
const anchorColumns = (now: Date) => ({
  gameId: gameSessions.gameId,
  lastDoneAt: sql<
    string | null
  >`max(case when ${gameSessions.status} = 'done' then ${gameSessions.doneAt} end)`,
  firstSessionAt: sql<
    string | null
  >`min(case when ${gameSessions.status} <> 'cancelled' or ${gameSessions.startsAt} < ${now} then ${gameSessions.startsAt} end)`,
});

const toAnchorMap = (
  rows: { gameId: number; lastDoneAt: string | null; firstSessionAt: string | null }[],
): Map<number, Anchors> =>
  new Map(
    rows.map((r) => [
      r.gameId,
      { lastDoneAt: asDate(r.lastDoneAt), firstSessionAt: asDate(r.firstSessionAt) },
    ]),
  );

/** Дати проведених і перших сесій для набору ігор — одним запитом. */
export async function sessionAnchors(
  db: DbLike,
  gameIds: number[],
  now: Date = new Date(),
): Promise<Map<number, Anchors>> {
  if (gameIds.length === 0) return new Map();
  const rows = await db
    .select(anchorColumns(now))
    .from(gameSessions)
    .where(inArray(gameSessions.gameId, gameIds))
    .groupBy(gameSessions.gameId);
  return toAnchorMap(rows);
}

/** Те саме для всіх ігор, які перевіряє детектор (`recruiting`/`started`) — без списку id. */
export async function checkedSessionAnchors(db: DbLike, now: Date): Promise<Map<number, Anchors>> {
  const rows = await db
    .select(anchorColumns(now))
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(inArray(games.status, CHECKED_STATUSES))
    .groupBy(gameSessions.gameId);
  return toAnchorMap(rows);
}

type GameRow = typeof games.$inferSelect;

/** `StaleInput` з рядка гри й агрегатів сесій (без сесій — перший слот правила). */
export function staleInputOf(
  row: Pick<
    GameRow,
    'status' | 'publishedAt' | 'startsAt' | 'deadSnoozedUntil' | 'deadExemptUntilSession'
  > &
    Partial<Pick<GameRow, 'resumedAt'>>,
  anchors: Anchors | undefined,
): StaleInput {
  return {
    status: row.status,
    publishedAt: row.publishedAt,
    lastDoneAt: anchors?.lastDoneAt ?? null,
    firstSessionAt: anchors?.firstSessionAt ?? row.startsAt,
    resumedAt: row.resumedAt ?? null,
    deadSnoozedUntil: row.deadSnoozedUntil,
    deadExemptUntilSession: row.deadExemptUntilSession,
  };
}

/** «Мертві» ігри майстра, що блокують створення нових (`GAME_CREATION_BLOCKED`). */
export async function deadGameIdsOf(db: DbLike, gmId: number): Promise<number[]> {
  const rows = await db
    .select({ id: games.id })
    .from(games)
    .where(
      and(
        eq(games.gmUserId, gmId),
        inArray(games.status, CHECKED_STATUSES),
        isNotNull(games.deadAt),
      ),
    )
    .orderBy(games.id);
  return rows.map((r) => r.id);
}

/** Чи перетинаються інтервали `[start, start + duration)`. */
export function intersects(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Пари ігор, чиї сесії перетинаються щонайменше `OVERLAP_MIN_INTERSECTIONS` разів (чиста
 * частина `overlapRule`): кожна пара сесій двох різних ігор, що перетинаються, — один перетин.
 */
export function overlappingGames(
  sessions: { gameId: number; startsAt: Date; durationMinutes: number }[],
): Set<number> {
  const list = sessions
    .map((s) => ({
      gameId: s.gameId,
      start: s.startsAt.getTime(),
      end: s.startsAt.getTime() + s.durationMinutes * 60_000,
    }))
    .sort((a, b) => a.start - b.start);
  const pairs = new Map<string, number>();
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length && list[j]!.start < a.end; j++) {
      const b = list[j]!;
      if (b.gameId === a.gameId || !intersects(a, b)) continue;
      const key = a.gameId < b.gameId ? `${a.gameId}:${b.gameId}` : `${b.gameId}:${a.gameId}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<number>();
  for (const [key, n] of pairs) {
    if (n < OVERLAP_MIN_INTERSECTIONS) continue;
    for (const id of key.split(':')) out.add(Number(id));
  }
  return out;
}

/**
 * Накладання ігор майстра: ігри (`recruiting`/`started`), чиї сесії (проведені й заплановані, не
 * скасовані) з початком за останні 4 тижні до `now` перетинаються з сесіями іншої його активної
 * гри щонайменше 3 рази.
 */
export async function overlapRule(db: DbLike, gmId: number, now: Date): Promise<Set<number>> {
  const from = new Date(now.getTime() - OVERLAP_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .select({
      gameId: gameSessions.gameId,
      startsAt: gameSessions.startsAt,
      durationMinutes: gameSessions.durationMinutes,
    })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(
      and(
        eq(games.gmUserId, gmId),
        inArray(games.status, CHECKED_STATUSES),
        inArray(gameSessions.status, ['scheduled', 'done']),
        gte(gameSessions.startsAt, from),
        lt(gameSessions.startsAt, now),
      ),
    );
  return overlappingGames(rows);
}

/**
 * Стан гри для майстра: `dead` — позначена детектором; `stale` — правило каже «нагадати» чи
 * «мертва» (ще не позначена); інакше `ok`.
 */
export function stalenessOf(
  row: Parameters<typeof staleInputOf>[0] & Pick<GameRow, 'deadAt'>,
  anchors: Parameters<typeof staleInputOf>[1],
  now: Date,
): StalenessState {
  if (row.deadAt !== null && isChecked(row.status)) return 'dead';
  return staleRule(staleInputOf(row, anchors), now) === 'ok' ? 'ok' : 'stale';
}
