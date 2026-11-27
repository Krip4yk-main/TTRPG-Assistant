import { and, asc, eq, exists, gt, inArray, isNull, lt, max, or, sql } from 'drizzle-orm';
import {
  expandOccurrences,
  START_WINDOW_MAX,
  windowEnd,
  type GameBusyDto,
  type PinnedGamesDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  calendarPinnedGames,
  gameMembers,
  games,
  gameSessions,
  userSettings,
} from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

const MINUTE_MS = 60_000;
/**
 * Найдовша зайнятість від сесії: тривалість ≤ 720 хв плюс вікно початку ≤ 720 хв — межа
 * SQL-префільтра за `starts_at`.
 */
const MAX_SESSION_MS = (720 + START_WINDOW_MAX) * MINUTE_MS;

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
  return (await gameBusyIntervalsForUsers(deps, [userId], from, to, now)).get(userId) ?? [];
}

/**
 * Те саме для кількох користувачів одразу (підбір спільного часу групи): фіксована кількість
 * запитів незалежно від кількості користувачів. Ключі результату — усі `userIds`.
 */
export async function gameBusyIntervalsForUsers(
  deps: AppDeps,
  userIds: readonly number[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<Map<number, GameBusy[]>> {
  const { db } = deps;
  const result = new Map<number, GameBusy[]>(userIds.map((u) => [u, []]));
  if (userIds.length === 0) return result;
  const ids = [...new Set(userIds)];

  const [settings, pins, mine] = await Promise.all([
    db
      .select({ userId: userSettings.userId, autoBusy: userSettings.calendarAutoBusy })
      .from(userSettings)
      .where(inArray(userSettings.userId, ids)),
    db
      .select({ userId: calendarPinnedGames.userId, gameId: calendarPinnedGames.gameId })
      .from(calendarPinnedGames)
      .where(inArray(calendarPinnedGames.userId, ids)),
    db
      .select()
      .from(games)
      .where(
        and(
          inArray(games.status, ['recruiting', 'started']),
          or(
            inArray(games.gmUserId, ids),
            exists(
              db
                .select({ one: sql`1` })
                .from(gameMembers)
                .where(
                  and(
                    eq(gameMembers.gameId, games.id),
                    inArray(gameMembers.userId, ids),
                    isNull(gameMembers.leftAt),
                  ),
                ),
            ),
          ),
        ),
      ),
  ]);
  if (mine.length === 0) return result;
  const gameIds = mine.map((g) => g.id);

  const [members, sessions, lastSlots] = await Promise.all([
    db
      .select({ gameId: gameMembers.gameId, userId: gameMembers.userId })
      .from(gameMembers)
      .where(
        and(
          inArray(gameMembers.gameId, gameIds),
          inArray(gameMembers.userId, ids),
          isNull(gameMembers.leftAt),
        ),
      ),
    db
      .select({
        id: gameSessions.id,
        gameId: gameSessions.gameId,
        startsAt: gameSessions.startsAt,
        durationMinutes: gameSessions.durationMinutes,
        startWindowMinutes: gameSessions.startWindowMinutes,
      })
      .from(gameSessions)
      .where(
        and(
          inArray(gameSessions.gameId, gameIds),
          eq(gameSessions.status, 'scheduled'),
          lt(gameSessions.startsAt, to),
          gt(gameSessions.startsAt, new Date(from.getTime() - MAX_SESSION_MS)),
        ),
      )
      .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id)),
    db
      .select({ gameId: gameSessions.gameId, last: max(gameSessions.ruleStartsAt) })
      .from(gameSessions)
      .where(inArray(gameSessions.gameId, gameIds))
      .groupBy(gameSessions.gameId),
  ]);

  // Проміжки кожної гри — один раз, далі розподіляються між її користувачами.
  const byId = new Map(mine.map((g) => [g.id, g]));
  const perGame = new Map<number, GameBusy[]>(gameIds.map((id) => [id, []]));
  for (const s of sessions) {
    // Приблизний час: зайнято від початку вікна до кінця вікна + тривалість.
    const end = new Date(
      windowEnd(s.startsAt, s.startWindowMinutes).getTime() + s.durationMinutes * MINUTE_MS,
    );
    if (end <= from) continue;
    perGame.get(s.gameId)!.push({
      gameId: s.gameId,
      gameTitle: byId.get(s.gameId)!.title,
      sessionId: s.id,
      start: s.startsAt,
      end,
    });
  }
  const last = new Map(lastSlots.map((r) => [r.gameId, r.last ? new Date(r.last) : null]));
  for (const g of mine) {
    // Без дати старту правило не має слотів (чернетки сюди й так не потрапляють).
    if (g.startsAt === null) continue;
    const after = last.get(g.id) ?? null;
    const duration = g.durationMinutes * MINUTE_MS;
    // Вікно початку правила: віртуальний слот зайнятий до кінця вікна + тривалість.
    const windowMs = (g.startWindowMinutes ?? 0) * MINUTE_MS;
    // Віртуальні слоти — лише ті, що ще не закінчились і йдуть після матеріалізованих.
    const lower = Math.max(from.getTime(), now.getTime()) - duration - windowMs;
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
      perGame.get(g.id)!.push({
        gameId: g.id,
        gameTitle: g.title,
        sessionId: null,
        start: o.start,
        end: new Date(o.end.getTime() + windowMs),
      });
    }
  }

  const autoBusy = new Map(settings.map((r) => [r.userId, r.autoBusy]));
  const pinned = new Set(pins.map((p) => `${p.userId}:${p.gameId}`));
  const memberOf = new Set(members.map((m) => `${m.userId}:${m.gameId}`));
  for (const u of ids) {
    const auto = autoBusy.get(u) ?? true;
    const out: GameBusy[] = [];
    for (const g of mine) {
      const key = `${u}:${g.id}`;
      if (g.gmUserId !== u && !memberOf.has(key)) continue;
      if (!auto && !pinned.has(key)) continue;
      out.push(...perGame.get(g.id)!);
    }
    result.set(
      u,
      out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.gameId - b.gameId),
    );
  }
  return result;
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
