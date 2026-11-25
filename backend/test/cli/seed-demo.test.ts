import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { checkRatingSnapshots } from '../../src/cli/demo/ratings-check.js';
import { findDemo, hasDemo, resetDemo } from '../../src/cli/demo/reset.js';
import { assertDevTarget, dbHostOf, seedDemo, tableCounts } from '../../src/cli/demo/seed.js';
import type { Db } from '../../src/db/client.js';
import {
  authIdentities,
  demoEntities,
  gameApplications,
  games,
  publishedRatings,
  ratings,
  users,
} from '../../src/db/schema/index.js';
import { maybePublish } from '../../src/ratings/ratings.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(() => closeDeps(deps));

const NOW = new Date('2026-11-25T12:00:00.000Z');
const OPTS = { scale: 0.2, seed: 42, now: NOW, unsafeSkipTargetGuard: true } as const;

async function createOwner() {
  const owner = await createUser(db, { nickname: 'Дошка_Власник', role: 'owner' });
  await db.insert(authIdentities).values({
    userId: owner.id,
    provider: 'dev',
    subject: 'Дошка_Власник',
    displayName: 'Дошка_Власник',
  });
  return owner;
}

/** Не-демо гра (мінімальні поля). */
async function insertGame(gmUserId: number): Promise<number> {
  const [res] = await db
    .insert(games)
    .values({
      gmUserId,
      title: 'Справжня гра',
      description: '',
      systemOther: 'Інша',
      genreId: 1,
      format: 'online',
      kind: 'campaign',
      startsAt: new Date('2026-09-01T17:00:00Z'),
      durationMinutes: 180,
      timezone: 'Europe/Kyiv',
      minPlayers: 1,
      maxPlayers: 5,
      status: 'finished',
      publishedAt: new Date('2026-08-20T10:00:00Z'),
      finishedAt: new Date('2026-10-01T10:00:00Z'),
    })
    .$returningId();
  return res!.id;
}

/** Оцінка гравцю від іншого гравця + `maybePublish`, як у `submitRating`. */
async function rate(q: Db, raterId: number, rateeId: number, gameId: number, overall: number) {
  await q.transaction(async (tx) => {
    await tx.insert(ratings).values({
      raterId,
      rateeId,
      gameId,
      kind: 'final',
      role: 'player_from_player',
      overall,
      criteria: { teamplay: overall },
    });
    await maybePublish(tx, rateeId, 'player_from_player');
  });
}

const sample = async () => ({
  titles: (
    await db
      .select({ t: games.title })
      .from(games)
      .innerJoin(
        demoEntities,
        and(eq(demoEntities.entityType, 'game'), eq(demoEntities.entityId, games.id)),
      )
  )
    .map((r) => r.t)
    .sort(),
  nicknames: (
    await db
      .select({ n: users.nickname })
      .from(users)
      .innerJoin(
        demoEntities,
        and(eq(demoEntities.entityType, 'user'), eq(demoEntities.entityId, users.id)),
      )
  )
    .map((r) => r.n)
    .sort(),
});

describe('seed-demo', () => {
  it('refuses outside development, on a test or non-local database unless allowed', async () => {
    const base = { nodeEnv: 'development', dbName: 'nri', host: 'localhost' };
    expect(() => assertDevTarget({ ...base, nodeEnv: 'test' })).toThrow(/NODE_ENV/);
    expect(() => assertDevTarget({ ...base, dbName: 'nri_test_3' })).toThrow(/test database/);
    expect(() => assertDevTarget({ ...base, host: 'db.example.com' })).toThrow(/not local/);
    expect(() => assertDevTarget({ ...base, host: undefined })).toThrow(/not local/);
    expect(() =>
      assertDevTarget({ ...base, host: 'db.example.com', allowRemote: true }),
    ).not.toThrow();
    expect(() => assertDevTarget(base)).not.toThrow();
    expect(() => assertDevTarget({ ...base, host: 'mysql' })).not.toThrow();
    expect(dbHostOf('mysql://u:p@127.0.0.1:3306/nri')).toBe('127.0.0.1');
    // Тести працюють з NODE_ENV=test і БД nri_test* — без внутрішнього прапорця сидер відмовляє.
    await expect(seedDemo(db, { scale: 0.1, now: NOW, dbHost: 'localhost' })).rejects.toThrow(
      /refusing to seed/,
    );
    expect(hasDemo(await findDemo(db))).toBe(false);
  });

  it('seeds consistent, deterministic data; reset + reseed is identical; owner untouched', async () => {
    const owner = await createOwner();
    const other = await createUser(db, { nickname: 'Звичайний' });

    const first = await seedDemo(db, OPTS);
    for (const t of [
      'users',
      'games',
      'game_sessions',
      'game_applications',
      'game_members',
      'session_attendance',
      'ratings',
      'published_ratings',
      'notifications',
      'availability_slots',
      'complaints',
      'sanctions',
      'sanction_appeals',
      'moderation_log',
      'gm_blacklist',
      'notes',
    ]) {
      expect(first.counts[t], t).toBeGreaterThan(0);
    }
    expect(first.ratingIssues).toEqual([]);
    expect(await checkRatingSnapshots(db)).toEqual([]);
    expect(first.ownerGameIds.length).toBeGreaterThanOrEqual(6);
    const ownerGm = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, owner.id));
    expect(ownerGm.some((r) => r.role === 'gm' && r.overall !== null)).toBe(true);
    const firstSample = await sample();
    expect(firstSample.titles.length).toBe(first.counts.games);
    await expect(seedDemo(db, OPTS)).rejects.toThrow(/already exists/);

    const second = await seedDemo(db, { ...OPTS, reset: true });
    expect(second.counts).toEqual(first.counts);
    expect(second.ratingIssues).toEqual([]);
    // Той самий seed — ті самі назви й ніки.
    expect(await sample()).toEqual(firstSample);

    await resetDemo(db);
    expect(hasDemo(await findDemo(db))).toBe(false);
    const left = await db.select().from(users);
    expect(left.map((u) => u.id).sort()).toEqual([owner.id, other.id].sort());
    const [ownerAfter] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(ownerAfter).toEqual(owner);
    expect(await db.select().from(games).where(inArray(games.id, second.ownerGameIds))).toEqual([]);
    expect(await db.select().from(ratings)).toEqual([]);
    const snaps = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, owner.id));
    expect(snaps.every((s) => s.units === 0 && s.overall === null && s.lastRatingId === null)).toBe(
      true,
    );
    const counts = await tableCounts(db);
    for (const t of ['notifications', 'complaints', 'moderation_log', 'games', 'game_sessions']) {
      expect(counts[t], t).toBe(0);
    }
  });

  it('a failure mid-seed leaves nothing behind (single transaction)', async () => {
    await createOwner();
    const before = await tableCounts(db);
    await expect(
      seedDemo(db, {
        ...OPTS,
        testHooks: {
          afterGames: () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow('boom');
    expect(await tableCounts(db)).toEqual(before);
    expect(hasDemo(await findDemo(db))).toBe(false);
    expect(await db.select().from(demoEntities)).toEqual([]);
  });

  it('reset removes only demo-linked rows of an organic user and rebuilds their snapshot', async () => {
    await createOwner();
    const organic = await createUser(db, { nickname: 'Органік' });
    const realGm = await createUser(db, { nickname: 'РеальнийМайстер' });
    const realGame = await insertGame(realGm.id);
    const realRaters = [];
    for (let i = 0; i < 5; i++) realRaters.push(await createUser(db, { nickname: `Реальний${i}` }));
    for (const [i, u] of realRaters.entries())
      await rate(db, u.id, organic.id, realGame, 3 + (i % 2));

    const res = await seedDemo(db, OPTS);
    const [demoGame] = await db
      .select()
      .from(games)
      .where(and(inArray(games.gmUserId, res.demoUserIds), eq(games.status, 'recruiting')))
      .limit(1);
    // Органічний користувач подав заявку на демо-гру й оцінив демо-майстра…
    await db.insert(gameApplications).values({
      gameId: demoGame!.id,
      userId: organic.id,
      answers: demoGame!.applicationQuestions.map(() => 'так'),
      constraints: [],
      warningsAcceptedAt: NOW,
    });
    await db.transaction(async (tx) => {
      await tx.insert(ratings).values({
        raterId: organic.id,
        rateeId: demoGame!.gmUserId,
        gameId: demoGame!.id,
        kind: 'final',
        role: 'gm',
        overall: 5,
      });
      await maybePublish(tx, demoGame!.gmUserId, 'gm');
    });
    // …а демо-гравці оцінили його (зріз перепубліковано з 10 одиниць).
    const demoRaters = res.demoUserIds.filter((id) => id !== demoGame!.gmUserId).slice(0, 5);
    for (const id of demoRaters) await rate(db, id, organic.id, demoGame!.id, 1);
    const [mid] = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, organic.id));
    expect(mid!.units).toBe(10);
    expect(await checkRatingSnapshots(db)).toEqual([]);

    await resetDemo(db);
    expect((await db.select().from(users).where(eq(users.id, organic.id))).length).toBe(1);
    expect(
      await db.select().from(gameApplications).where(eq(gameApplications.userId, organic.id)),
    ).toEqual([]);
    const left = await db.select().from(ratings);
    expect(left.length).toBe(5);
    expect(left.every((r) => r.gameId === realGame)).toBe(true);
    const [snap] = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, organic.id));
    expect(snap!.units).toBe(5);
    expect(snap!.overall).toBe(3.4);
    expect(snap!.lastRatingId).toBe(Math.max(...left.map((r) => r.id)));
    expect(await checkRatingSnapshots(db)).toEqual([]);
    expect((await db.select().from(games).where(eq(games.id, realGame))).length).toBe(1);
  });
});
