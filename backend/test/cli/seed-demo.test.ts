import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { checkRatingSnapshots } from '../../src/cli/demo/ratings-check.js';
import { findDemo, hasDemo, resetDemo } from '../../src/cli/demo/reset.js';
import { assertDevTarget, seedDemo, tableCounts } from '../../src/cli/demo/seed.js';
import {
  authIdentities,
  games,
  publishedRatings,
  ratings,
  users,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(() => closeDeps(deps));

const NOW = new Date('2026-11-25T12:00:00.000Z');
const OPTS = { scale: 0.2, seed: 42, now: NOW, unsafeSkipTargetGuard: true } as const;

describe('seed-demo', () => {
  it('refuses outside development / on a test database unless the internal flag is set', async () => {
    expect(() => assertDevTarget('test', 'nri')).toThrow(/NODE_ENV/);
    expect(() => assertDevTarget('development', 'nri_test_3')).toThrow(/test database/);
    expect(() => assertDevTarget('development', 'nri')).not.toThrow();
    // Тести працюють з NODE_ENV=test і БД nri_test* — без прапорця сидер відмовляє.
    await expect(seedDemo(db, { scale: 0.1, now: NOW })).rejects.toThrow(/refusing to seed/);
    expect(hasDemo(await findDemo(db))).toBe(false);
  });

  it('seeds consistent data; reset + reseed gives the same counts; owner untouched', async () => {
    const owner = await createUser(db, { nickname: 'Дошка_Власник', role: 'owner' });
    await db.insert(authIdentities).values({
      userId: owner.id,
      provider: 'dev',
      subject: 'Дошка_Власник',
      displayName: 'Дошка_Власник',
    });
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
    // Власник має опублікований рейтинг майстра від демо-гравців.
    const ownerGm = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, owner.id));
    expect(ownerGm.some((r) => r.role === 'gm' && r.overall !== null)).toBe(true);
    // Повторний запуск без --reset відмовляє.
    await expect(seedDemo(db, OPTS)).rejects.toThrow(/already exists/);

    const second = await seedDemo(db, { ...OPTS, reset: true });
    expect(second.counts).toEqual(first.counts);
    expect(second.ratingIssues).toEqual([]);

    await resetDemo(db);
    expect(hasDemo(await findDemo(db))).toBe(false);
    const left = await db.select().from(users);
    expect(left.map((u) => u.id).sort()).toEqual([owner.id, other.id].sort());
    const [ownerAfter] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(ownerAfter).toEqual(owner);
    expect(await db.select().from(games).where(inArray(games.id, second.ownerGameIds))).toEqual([]);
    expect(await db.select().from(ratings)).toEqual([]);
    // Зріз власника перебудовано з того, що лишилось (нічого) — заготовка.
    const snaps = await db
      .select()
      .from(publishedRatings)
      .where(eq(publishedRatings.userId, owner.id));
    expect(snaps.every((s) => s.units === 0 && s.overall === null && s.lastRatingId === null)).toBe(
      true,
    );
    const counts = await tableCounts(db);
    expect(counts.notifications).toBe(0);
    expect(counts.complaints).toBe(0);
    expect(counts.moderation_log).toBe(0);
  });
});
