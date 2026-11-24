import { and, asc, eq, exists, gt, inArray, isNull, lt, max, or, sql } from 'drizzle-orm';
import { expandOccurrences, type GameBusyDto, type PinnedGamesDto } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { getCalendarSettings } from '../availability/availability.service.js';
import { calendarPinnedGames, gameMembers, games, gameSessions } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

const MINUTE_MS = 60_000;
/** Найдовша сесія (`durationMinutes ≤ 720`): межа SQL-префільтра за `starts_at`. */
const MAX_SESSION_MS = 720 * MINUTE_MS;

/** Зайнятий проміжок від гри (внутрішня форма `GameBusyDto`). */
export interface GameBusy {
  gameId: number;
  gameTitle: string;
  sessionId: number | null;
  start: Date;
  end: Date;
}

/**
 * Зайнятість користувача від ігор у `[from, to)` — обчислюється щоразу з `game_sessions`
 * (без збережених копій), тож перенесення, скасування, завершення гри й вихід з неї
 * враховуються одразу.
 *
 * - Ігри: `recruiting|started`, де користувач майстер або активний учасник
 *   (`left_at IS NULL`); якщо `calendar_autobusy` вимкнено — лише закріплені вручну.
 * - Сесії: `scheduled`, що перетинаються з `[from, to)` (лише дотик — не перетин).
 * - Слоти правила після останнього матеріалізованого (`MAX(rule_starts_at)`; вікно
 *   матеріалізації — 28 діб) додаються як «віртуальні» (`sessionId: null`), якщо ще не
 *   закінчились: їх ще ніхто не переносив і не скасовував.
 */
export async function gameBusyIntervals(
  deps: AppDeps,
  userId: number,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<GameBusy[]> {
  const { db } = deps;
  const { calendarAutoBusy } = await getCalendarSettings(deps, userId);
  const activeMember = exists(
    db
      .select({ one: sql`1` })
      .from(gameMembers)
      .where(
        and(
          eq(gameMembers.gameId, games.id),
          eq(gameMembers.userId, userId),
          isNull(gameMembers.leftAt),
        ),
      ),
  );
  const pinned = exists(
    db
      .select({ one: sql`1` })
      .from(calendarPinnedGames)
      .where(and(eq(calendarPinnedGames.gameId, games.id), eq(calendarPinnedGames.userId, userId))),
  );
  const mine = await db
    .select()
    .from(games)
    .where(
      and(
        inArray(games.status, ['recruiting', 'started']),
        or(eq(games.gmUserId, userId), activeMember),
        calendarAutoBusy ? undefined : pinned,
      ),
    );
  if (mine.length === 0) return [];
  const ids = mine.map((g) => g.id);

  const [sessions, lastSlots] = await Promise.all([
    db
      .select({
        id: gameSessions.id,
        gameId: gameSessions.gameId,
        startsAt: gameSessions.startsAt,
        durationMinutes: gameSessions.durationMinutes,
      })
      .from(gameSessions)
      .where(
        and(
          inArray(gameSessions.gameId, ids),
          eq(gameSessions.status, 'scheduled'),
          lt(gameSessions.startsAt, to),
          gt(gameSessions.startsAt, new Date(from.getTime() - MAX_SESSION_MS)),
        ),
      )
      .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id)),
    db
      .select({ gameId: gameSessions.gameId, last: max(gameSessions.ruleStartsAt) })
      .from(gameSessions)
      .where(inArray(gameSessions.gameId, ids))
      .groupBy(gameSessions.gameId),
  ]);

  const byId = new Map(mine.map((g) => [g.id, g]));
  const out: GameBusy[] = [];
  for (const s of sessions) {
    const end = new Date(s.startsAt.getTime() + s.durationMinutes * MINUTE_MS);
    if (end <= from) continue;
    out.push({
      gameId: s.gameId,
      gameTitle: byId.get(s.gameId)!.title,
      sessionId: s.id,
      start: s.startsAt,
      end,
    });
  }

  const last = new Map(lastSlots.map((r) => [r.gameId, r.last ? new Date(r.last) : null]));
  for (const g of mine) {
    const after = last.get(g.id) ?? null;
    const duration = g.durationMinutes * MINUTE_MS;
    // Віртуальні слоти — лише ті, що ще не закінчились і йдуть після матеріалізованих.
    const lower = Math.max(from.getTime(), now.getTime()) - duration;
    const occ = expandOccurrences(
      {
        startsAt: g.startsAt.toISOString(),
        durationMinutes: g.durationMinutes,
        recurrence: g.recurrence,
        weekdays: g.weekdays,
        timezone: g.timezone,
      },
      new Date(lower + 1),
      to,
    );
    for (const o of occ) {
      if (after && o.start <= after) continue;
      out.push({ gameId: g.id, gameTitle: g.title, sessionId: null, start: o.start, end: o.end });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.gameId - b.gameId);
}

export async function gameBusy(
  deps: AppDeps,
  userId: number,
  from: Date,
  to: Date,
): Promise<GameBusyDto[]> {
  const rows = await gameBusyIntervals(deps, userId, from, to);
  return rows.map((r) => ({
    gameId: r.gameId,
    gameTitle: r.gameTitle,
    sessionId: r.sessionId,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
  }));
}

// ---------- ручне закріплення ----------

/**
 * «Додати в мій календар» (для режиму без автозайнятості): лише майстер або активний
 * учасник гри. Ідемпотентно. Невідома (чи прихована від не-майстра) гра → 404,
 * сторонній → 403 `NOT_A_MEMBER`.
 */
export async function pinGame(deps: AppDeps, userId: number, gameId: number): Promise<void> {
  const { db } = deps;
  const [g] = await db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.gmUserId !== userId) {
    if (isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
    const [m] = await db
      .select({ id: gameMembers.id })
      .from(gameMembers)
      .where(
        and(
          eq(gameMembers.gameId, gameId),
          eq(gameMembers.userId, userId),
          isNull(gameMembers.leftAt),
        ),
      );
    if (!m) throw new AppError(403, 'NOT_A_MEMBER');
  }
  await db.insert(calendarPinnedGames).ignore().values({ userId, gameId });
}

/** Прибрати гру з календаря — завжди дозволено (і після виходу з гри); ідемпотентно. */
export async function unpinGame(deps: AppDeps, userId: number, gameId: number): Promise<void> {
  await deps.db
    .delete(calendarPinnedGames)
    .where(and(eq(calendarPinnedGames.userId, userId), eq(calendarPinnedGames.gameId, gameId)));
}

export async function listPinnedGames(deps: AppDeps, userId: number): Promise<PinnedGamesDto> {
  const rows = await deps.db
    .select({ gameId: calendarPinnedGames.gameId })
    .from(calendarPinnedGames)
    .where(eq(calendarPinnedGames.userId, userId))
    .orderBy(asc(calendarPinnedGames.gameId));
  return { gameIds: rows.map((r) => r.gameId) };
}
