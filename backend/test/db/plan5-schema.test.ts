import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  games,
  gameSessions,
  gameSystems,
  genres,
  publishedRatings,
  ratingReminderLog,
  ratings,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

/** drizzle загортає помилку mysql2 («Failed query …»): текст MySQL — у `cause`. */
const mysqlError = (re: RegExp) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringMatching(re) }),
  });
const DUP = mysqlError(/Duplicate entry/);
const CHECK_FAILED = mysqlError(/ratings_declined_ck/);

async function setup() {
  const gm = await createUser(db, { nickname: 'Gm' });
  const player = await createUser(db, { nickname: 'Player' });
  const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [g] = await db
    .insert(games)
    .values({
      gmUserId: gm.id,
      title: 'Гра',
      description: '',
      systemId: sys!.id,
      genreId: gen!.id,
      format: 'online',
      kind: 'campaign',
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      durationMinutes: 240,
      recurrence: 'none',
      weekdays: [],
      timezone: 'Europe/Kyiv',
      minPlayers: 1,
      maxPlayers: 5,
      status: 'recruiting',
      publishedAt: new Date(),
    })
    .$returningId();
  const gameId = g!.id;
  const [s] = await db
    .insert(gameSessions)
    .values({ gameId, startsAt: new Date(), durationMinutes: 180, origin: 'manual' })
    .$returningId();
  return { gm, player, gameId, sessionId: s!.id };
}

describe('plan 5 schema', () => {
  it('one session rating per session and one final rating per game for a pair', async () => {
    const { gm, player, gameId, sessionId } = await setup();
    const base = { raterId: player.id, rateeId: gm.id, gameId, role: 'gm' as const };
    await db.insert(ratings).values({ ...base, sessionId, kind: 'session', overall: 5 });
    await expect(
      db.insert(ratings).values({ ...base, sessionId, kind: 'session', declined: true }),
    ).rejects.toThrow(DUP);
    await db
      .insert(ratings)
      .values({ ...base, kind: 'final', overall: 4, criteria: { safety: 5 } });
    await expect(db.insert(ratings).values({ ...base, kind: 'final', overall: 3 })).rejects.toThrow(
      DUP,
    );
    // Зворотний напрям — інша пара.
    await db.insert(ratings).values({
      raterId: gm.id,
      rateeId: player.id,
      gameId,
      kind: 'final',
      role: 'player_from_gm',
      overall: 2,
    });
    const rows = await db.select().from(ratings).where(eq(ratings.gameId, gameId));
    expect(rows).toHaveLength(3);
    const final = rows.find((r) => r.raterId === player.id && r.kind === 'final')!;
    expect(final.slotKey).toBe(0);
    expect(final.criteria).toEqual({ safety: 5 });
    expect(final.declined).toBe(false);
    expect(rows.find((r) => r.kind === 'session')!.slotKey).toBe(sessionId);
  });

  it('declined rows carry no scores; scored rows need overall 1..5', async () => {
    const { gm, player, gameId } = await setup();
    const base = { raterId: player.id, rateeId: gm.id, gameId, role: 'gm' as const };
    const bad = [
      { declined: true, overall: 3 },
      { declined: true, criteria: { safety: 5 } },
      { declined: true, comment: 'x' },
      { declined: false },
      { declined: false, overall: 0 },
      { declined: false, overall: 6 },
    ];
    for (const v of bad) {
      await expect(db.insert(ratings).values({ ...base, kind: 'final', ...v })).rejects.toThrow(
        CHECK_FAILED,
      );
    }
    await db.insert(ratings).values({ ...base, kind: 'final', declined: true });
    expect(await db.select().from(ratings)).toHaveLength(1);
  });

  it('deleting a session cascades its ratings and reminder log rows', async () => {
    const { gm, player, gameId, sessionId } = await setup();
    await db.insert(ratings).values({
      raterId: player.id,
      rateeId: gm.id,
      gameId,
      sessionId,
      kind: 'session',
      role: 'gm',
      overall: 5,
    });
    await db
      .insert(ratingReminderLog)
      .values({ userId: player.id, gameId, sessionId, kind: 'deadline' });
    await db.delete(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect(await db.select().from(ratingReminderLog)).toHaveLength(0);
  });

  it('reminder log is unique per user, game, slot and kind', async () => {
    const { player, gameId, sessionId } = await setup();
    const r = { userId: player.id, gameId, kind: 'deadline' as const };
    await db.insert(ratingReminderLog).values(r);
    await expect(db.insert(ratingReminderLog).values(r)).rejects.toThrow(DUP);
    await db.insert(ratingReminderLog).values({ ...r, sessionId });
    await expect(db.insert(ratingReminderLog).values({ ...r, sessionId })).rejects.toThrow(DUP);
  });

  it('published ratings keyed by user and role, stores 2 decimals', async () => {
    const { gm } = await setup();
    await db.insert(publishedRatings).values({
      userId: gm.id,
      role: 'gm',
      overall: 4.567,
      overallUnits: 5,
      criteria: { safety: { avg: 4.2, units: 5 } },
      units: 5,
      lastRatingId: 10,
      publishedAt: new Date(),
    });
    await expect(db.insert(publishedRatings).values({ userId: gm.id, role: 'gm' })).rejects.toThrow(
      DUP,
    );
    await db.insert(publishedRatings).values({ userId: gm.id, role: 'player_from_player' });
    const [row] = await db
      .select()
      .from(publishedRatings)
      .where(sql`${publishedRatings.userId} = ${gm.id} AND ${publishedRatings.role} = 'gm'`);
    expect(row!.overall).toBe(4.57);
    expect(row!.criteria).toEqual({ safety: { avg: 4.2, units: 5 } });
  });

  it('resetDb clears the new tables', async () => {
    const { gm, player, gameId } = await setup();
    await db.insert(ratings).values({
      raterId: player.id,
      rateeId: gm.id,
      gameId,
      kind: 'final',
      role: 'gm',
      declined: true,
    });
    await db.insert(publishedRatings).values({ userId: gm.id, role: 'gm' });
    await db.insert(ratingReminderLog).values({ userId: player.id, gameId, kind: 'deadline' });
    await resetDb(db);
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect(await db.select().from(publishedRatings)).toHaveLength(0);
    expect(await db.select().from(ratingReminderLog)).toHaveLength(0);
  });
});
