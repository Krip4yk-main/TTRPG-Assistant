import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createSession, resolveSession } from '../../src/auth/session.service.js';
import {
  authIdentities,
  gameApplications,
  gameSessions,
  games,
  gameSystems,
  genres,
  notifications,
  reminderLog,
  users,
} from '../../src/db/schema/index.js';
import {
  materializeAll,
  purgePendingUsers,
  purgeReadNotifications,
  purgeReminderLog,
  runDaily,
} from '../../src/jobs/daily.js';
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
const NOW = new Date('2027-03-17T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function insertGame(patch: Partial<typeof games.$inferInsert> = {}): Promise<number> {
  const gm = patch.gmUserId ? null : await createUser(db, { nickname: null });
  const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [r] = await db
    .insert(games)
    .values({
      gmUserId: gm?.id ?? patch.gmUserId!,
      title: 'Гра',
      description: '',
      systemId: sys!.id,
      genreId: gen!.id,
      format: 'online',
      kind: 'campaign',
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

const countSessions = async (gameId: number) =>
  (await db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId))).length;

describe('materializeAll', () => {
  it('extends the window for running games only, idempotently', async () => {
    const recruiting = await insertGame();
    const started = await insertGame({ status: 'started', startedAt: NOW });
    const finished = await insertGame({ status: 'finished', finishedAt: NOW });
    const draft = await insertGame({ status: 'draft', publishedAt: null });

    const first = await materializeAll(deps, NOW);
    expect(first).toBe(8); // 2 гри × 4 четверги у 28-денному вікні
    expect(await countSessions(recruiting)).toBe(4);
    expect(await countSessions(started)).toBe(4);
    expect(await countSessions(finished)).toBe(0);
    expect(await countSessions(draft)).toBe(0);

    expect(await materializeAll(deps, NOW)).toBe(0);
    // Через тиждень вікно зсувається: +1 сесія на гру.
    expect(await materializeAll(deps, new Date(NOW.getTime() + 7 * DAY))).toBe(2);
    expect(await countSessions(recruiting)).toBe(5);
    expect(await materializeAll(deps, new Date(NOW.getTime() + 7 * DAY))).toBe(0);
  });

  it('a non-transient failure of one game is logged and does not stop the others or fail the job', async () => {
    // Невідомий пояс — розгортання правила падає саме для цієї гри.
    await insertGame({ timezone: 'Nowhere/Invalid' });
    const b = await insertGame();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await materializeAll(deps, NOW)).toBe(4);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await countSessions(b)).toBe(4);
  });
});

describe('purgePendingUsers', () => {
  it('deletes stale pending users without applications/games/memberships, keeps the rest (incl. banned)', async () => {
    const stale = await createUser(db, { status: 'pending', createdAt: daysAgo(8) });
    await db
      .insert(authIdentities)
      .values({ userId: stale.id, provider: 'dev', subject: `dev-${stale.id}` });
    const { token } = await createSession(deps, stale.id, {});
    expect(await resolveSession(deps, token)).not.toBeNull(); // кеш сесії в Redis

    const fresh = await createUser(db, { status: 'pending', createdAt: daysAgo(6) });
    const banned = await createUser(db, {
      status: 'pending',
      isBanned: true,
      createdAt: daysAgo(30),
    });
    const active = await createUser(db, { status: 'active', createdAt: daysAgo(30) });
    const gm = await createUser(db, { status: 'pending', createdAt: daysAgo(30) });
    await insertGame({ gmUserId: gm.id, status: 'draft', publishedAt: null });
    const applicant = await createUser(db, { status: 'pending', createdAt: daysAgo(30) });
    const gameId = await insertGame();
    await db.insert(gameApplications).values({
      gameId,
      userId: applicant.id,
      answers: [],
      constraints: [],
      warningsAcceptedAt: NOW,
    });

    expect(await purgePendingUsers(deps, NOW)).toBe(1);
    const left = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, [stale.id, fresh.id, banned.id, active.id, gm.id, applicant.id]))
    ).map((u) => u.id);
    expect(left.sort((x, y) => x - y)).toEqual(
      [fresh.id, banned.id, active.id, gm.id, applicant.id].sort((x, y) => x - y),
    );
    expect(
      await db.select().from(authIdentities).where(eq(authIdentities.userId, stale.id)),
    ).toEqual([]);
    expect(await resolveSession(deps, token)).toBeNull();
    expect(await purgePendingUsers(deps, NOW)).toBe(0);
  });
});

describe('purges', () => {
  it('read notifications older than 90 days are purged in batches; unread and recent kept', async () => {
    const u = await createUser(db);
    const row = (readAt: Date | null, createdAt = daysAgo(200)) => ({
      userId: u.id,
      type: 'game.started',
      category: 'games' as const,
      payload: {},
      readAt,
      createdAt,
    });
    // 1001 старих прочитаних — дві пачки.
    await db.insert(notifications).values(Array.from({ length: 1001 }, () => row(daysAgo(91))));
    await db.insert(notifications).values([row(daysAgo(89)), row(null), row(null)]);
    expect(await purgeReadNotifications(deps, NOW)).toBe(1001);
    const rest = await db.select().from(notifications);
    expect(rest).toHaveLength(3);
    expect(rest.filter((n) => n.readAt === null)).toHaveLength(2);
  });

  it('reminder_log older than 30 days is purged', async () => {
    const u = await createUser(db);
    const gameId = await insertGame();
    await materializeAll(deps, NOW);
    const [s] = await db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId));
    await db.insert(reminderLog).values([
      { sessionId: s!.id, userId: u.id, offsetMin: 60, startsAt: s!.startsAt, sentAt: daysAgo(31) },
      { sessionId: s!.id, userId: u.id, offsetMin: 15, startsAt: s!.startsAt, sentAt: daysAgo(29) },
    ]);
    expect(await purgeReminderLog(deps, NOW)).toBe(1);
    const rest = await db.select().from(reminderLog);
    expect(rest.map((r) => r.offsetMin)).toEqual([15]);
  });

  it('runDaily isolates steps: a failing step does not skip the others', async () => {
    const stale = await createUser(db, { status: 'pending', createdAt: daysAgo(8) });
    const u = await createUser(db);
    await db.insert(notifications).values({
      userId: u.id,
      type: 'game.started',
      category: 'games',
      payload: {},
      readAt: daysAgo(100),
    });
    await insertGame({ timezone: 'Nowhere/Invalid' }); // матеріалізація падає
    const gameId = await insertGame();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runDaily(deps, NOW)).resolves.toBeUndefined(); // не-тимчасова — без повтору
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await countSessions(gameId)).toBe(4);
    expect(await db.select().from(users).where(eq(users.id, stale.id))).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
  });
});
