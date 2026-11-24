import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { toZoned } from '@nri/shared';
import { gameSessions, games, gameSystems, genres } from '../../src/db/schema/index.js';
import { materializeSessions } from '../../src/sessions/materialize.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;

async function insertGame(patch: Partial<typeof games.$inferInsert> = {}): Promise<number> {
  const gm = await createUser(db, { nickname: null });
  const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [r] = await db
    .insert(games)
    .values({
      gmUserId: gm.id,
      title: 'Гра',
      description: '',
      systemId: sys!.id,
      genreId: gen!.id,
      format: 'online',
      kind: 'campaign',
      // Четвер 2027-03-18 19:00 Kyiv (EET, UTC+2).
      startsAt: new Date('2027-03-18T17:00:00Z'),
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [3],
      timezone: 'Europe/Kyiv',
      minPlayers: 1,
      maxPlayers: 5,
      status: 'recruiting',
      publishedAt: new Date(),
      ...patch,
    })
    .$returningId();
  return r!.id;
}

const sessionsOf = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));

const NOW = new Date('2027-03-17T12:00:00Z');

describe('materializeSessions', () => {
  it('weekly game: sessions for the 4-week window, local 19:00 Kyiv across DST (2027-03-28)', async () => {
    const id = await insertGame();
    await materializeSessions(deps, id, NOW);
    const rows = await sessionsOf(id);
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual([
      '2027-03-18T17:00:00.000Z',
      '2027-03-25T17:00:00.000Z',
      '2027-04-01T16:00:00.000Z',
      '2027-04-08T16:00:00.000Z',
    ]);
    for (const r of rows) {
      const z = toZoned(r.startsAt, 'Europe/Kyiv');
      expect([z.hour, z.minute, z.weekday]).toEqual([19, 0, 3]);
      expect(r).toMatchObject({
        status: 'scheduled',
        origin: 'rule',
        rescheduled: false,
        durationMinutes: 240,
      });
      expect(r.ruleStartsAt!.getTime()).toBe(r.startsAt.getTime());
    }
  });

  it('is idempotent, also when two calls race', async () => {
    const id = await insertGame();
    await materializeSessions(deps, id, NOW);
    await materializeSessions(deps, id, NOW);
    await Promise.all([
      materializeSessions(deps, id, NOW),
      materializeSessions(deps, id, NOW),
      materializeSessions(deps, id, NOW),
    ]);
    expect(await sessionsOf(id)).toHaveLength(4);
  });

  it('concurrent first materialization does not duplicate', async () => {
    for (let i = 0; i < 3; i++) {
      await resetDb(db);
      const id = await insertGame();
      const res = await Promise.allSettled([
        materializeSessions(deps, id, NOW),
        materializeSessions(deps, id, NOW),
      ]);
      expect(res.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await sessionsOf(id)).toHaveLength(4);
    }
  }, 30_000);

  it('the window slides forward', async () => {
    const id = await insertGame();
    await materializeSessions(deps, id, NOW);
    await materializeSessions(deps, id, new Date(NOW.getTime() + 7 * DAY));
    expect(await sessionsOf(id)).toHaveLength(5);
  });

  it('does not restore rescheduled or cancelled sessions and keeps done ones', async () => {
    const id = await insertGame();
    await materializeSessions(deps, id, NOW);
    const [s1, s2, s3] = await sessionsOf(id);
    const moved = new Date('2027-03-27T10:00:00Z');
    await db
      .update(gameSessions)
      .set({ startsAt: moved, rescheduled: true })
      .where(eq(gameSessions.id, s2!.id));
    await db
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: 'хворію' })
      .where(eq(gameSessions.id, s3!.id));
    await db
      .update(gameSessions)
      .set({ status: 'done', doneAt: NOW })
      .where(eq(gameSessions.id, s1!.id));
    await materializeSessions(deps, id, NOW);
    const rows = await sessionsOf(id);
    expect(rows).toHaveLength(4);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(s1!.id)!.status).toBe('done');
    expect(byId.get(s2!.id)!.startsAt.toISOString()).toBe(moved.toISOString());
    expect(byId.get(s3!.id)!.status).toBe('cancelled');
    // Слот перенесеної сесії (25.03) не створено заново.
    expect(rows.filter((r) => r.startsAt.toISOString() === '2027-03-25T17:00:00.000Z')).toEqual([]);
  });

  it('only recruiting/started games are materialized', async () => {
    for (const status of ['draft', 'finished', 'cancelled'] as const) {
      const id = await insertGame({ status });
      await materializeSessions(deps, id, NOW);
      expect(await sessionsOf(id)).toHaveLength(0);
    }
    const started = await insertGame({ status: 'started' });
    await materializeSessions(deps, started, NOW);
    expect(await sessionsOf(started)).toHaveLength(4);
  });

  it('oneshot: a single session', async () => {
    const id = await insertGame({ kind: 'oneshot', recurrence: 'none', weekdays: [] });
    await materializeSessions(deps, id, NOW);
    await materializeSessions(deps, id, new Date(NOW.getTime() + 2 * DAY));
    const rows = await sessionsOf(id);
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual(['2027-03-18T17:00:00.000Z']);
  });
});
