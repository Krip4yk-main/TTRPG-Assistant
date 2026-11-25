import type { Db } from '../../src/db/client.js';
import {
  gameMembers,
  games,
  gameSessions,
  gameSystems,
  genres,
  sessionAttendance,
} from '../../src/db/schema/index.js';

export const DAY = 86_400_000;
export const MIN = 60_000;
/** Секундна точність, як у DATETIME без fsp. */
export const at = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);

type GameRow = typeof games.$inferInsert;

/** Прямі вставки гри/членств/сесій: час — довільний (вікна перевіряються з injectable `now`). */
export function ratingFixtures(db: Db) {
  async function game(gmUserId: number, patch: Partial<GameRow> = {}): Promise<number> {
    const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
    const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
    const [g] = await db
      .insert(games)
      .values({
        gmUserId,
        title: 'Гра',
        description: '',
        systemId: sys!.id,
        genreId: gen!.id,
        format: 'online',
        kind: 'campaign',
        startsAt: at(Date.now() - 100 * DAY),
        durationMinutes: 240,
        recurrence: 'none',
        weekdays: [],
        timezone: 'Europe/Kyiv',
        minPlayers: 1,
        maxPlayers: 5,
        status: 'started',
        publishedAt: at(Date.now() - 100 * DAY),
        ...patch,
      })
      .$returningId();
    return g!.id;
  }

  async function member(
    gameId: number,
    userId: number,
    joinedAt: Date,
    leftAt: Date | null = null,
    reason: 'left' | 'kicked' | 'banned' = 'left',
  ): Promise<void> {
    await db.insert(gameMembers).values({
      gameId,
      userId,
      joinedAt,
      leftAt,
      leftReason: leftAt ? reason : null,
    });
  }

  /** `done`-сесія з присутністю (`present`/`absent` — id користувачів; майстра не вказують). */
  async function done(
    gameId: number,
    doneAt: Date,
    present: number[] = [],
    absent: number[] = [],
  ): Promise<number> {
    const [s] = await db
      .insert(gameSessions)
      .values({
        gameId,
        startsAt: at(doneAt.getTime() - 4 * 3600_000),
        durationMinutes: 240,
        origin: 'manual',
        status: 'done',
        doneAt,
      })
      .$returningId();
    const rows = [
      ...present.map((userId) => ({ sessionId: s!.id, userId, present: true })),
      ...absent.map((userId) => ({ sessionId: s!.id, userId, present: false })),
    ];
    if (rows.length) await db.insert(sessionAttendance).values(rows);
    return s!.id;
  }

  return { game, member, done };
}
