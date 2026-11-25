import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { RatingRole } from '@nri/shared';
import { events, publishedRatings, ratings } from '../../src/db/schema/index.js';
import {
  computeRating,
  toPublishedDto,
  type AggregateRow,
} from '../../src/ratings/ratings.aggregate.js';
import { maybePublish, submitRating, userRatings } from '../../src/ratings/ratings.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { at, DAY, ratingFixtures } from './fixtures.js';

const deps = await testDeps();
const { db } = deps;
const fx = ratingFixtures(db);

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

const row = (raterId: number, gameId: number, overall: number, criteria = {}): AggregateRow => ({
  raterId,
  gameId,
  overall,
  criteria,
});

describe('computeRating (pure)', () => {
  it('a unit is (rater, game): their ratings in one game average into one unit', () => {
    const r = computeRating([...Array.from({ length: 10 }, () => row(1, 1, 5)), row(2, 1, 1)]);
    expect(r).toEqual({ overall: 3, overallUnits: 2, criteria: {}, units: 2 });
  });

  it('the same rater in two games is two units', () => {
    expect(computeRating([row(1, 1, 5), row(1, 2, 3)]).units).toBe(2);
  });

  it('criteria are averaged per unit; a missing criterion is not counted', () => {
    const r = computeRating([
      row(1, 1, 4, { preparation: 5 }),
      row(1, 1, 2, { preparation: 3, safety: 4 }),
      row(2, 1, 5),
      row(3, 1, 3, { preparation: 2 }),
    ]);
    expect(r.overall).toBe(3.67); // (3 + 5 + 3) / 3
    expect(r.criteria).toEqual({
      preparation: { avg: 3, units: 2 }, // (4 + 2) / 2
      safety: { avg: 4, units: 1 },
    });
  });

  it('no rows → no units', () => {
    expect(computeRating([])).toEqual({ overall: null, overallUnits: 0, criteria: {}, units: 0 });
  });
});

describe('toPublishedDto', () => {
  it('null below 5 units; criteria shown only with ≥5 units; 1 decimal', () => {
    expect(toPublishedDto(undefined)).toBeNull();
    expect(toPublishedDto({ overall: null, units: 0, criteria: null })).toBeNull();
    expect(toPublishedDto({ overall: 4.7, units: 4, criteria: null })).toBeNull();
    expect(
      toPublishedDto({
        overall: 4.25,
        units: 5,
        criteria: { preparation: { avg: 3.33, units: 5 }, safety: { avg: 5, units: 4 } },
      }),
    ).toEqual({ overall: 4.3, units: 5, criteria: { preparation: 3.3 } });
  });
});

// ---------- публікація пачками ----------

const T0 = at(Date.UTC(2026, 5, 1, 12));
const days = (n: number) => at(T0.getTime() + n * DAY);

/** Пряма вставка оцінки (без перевірки прав) — для перевірки агрегації. */
async function insertRating(
  raterId: number,
  rateeId: number,
  gameId: number,
  opts: {
    sessionId?: number;
    role?: RatingRole;
    overall?: number;
    criteria?: Record<string, number>;
    declined?: boolean;
  } = {},
) {
  const declined = opts.declined ?? false;
  await db.insert(ratings).values({
    raterId,
    rateeId,
    gameId,
    sessionId: opts.sessionId ?? null,
    kind: opts.sessionId ? 'session' : 'final',
    role: opts.role ?? 'gm',
    declined,
    overall: declined ? null : (opts.overall ?? 4),
    criteria: declined ? null : (opts.criteria ?? null),
  });
}

const publish = (userId: number, role: RatingRole = 'gm') =>
  db.transaction((tx) => maybePublish(tx, userId, role));

async function snapshot(userId: number, role: RatingRole = 'gm') {
  const [r] = await db
    .select()
    .from(publishedRatings)
    .where(and(eq(publishedRatings.userId, userId), eq(publishedRatings.role, role)));
  return r;
}

/** Майстер і `n` оцінювачів; кожен оцінювач — окрема гра (одна одиниця на оцінювача). */
async function raters(n: number) {
  const gm = await createUser(db, { nickname: 'Майстер' });
  const list: { id: number; gameId: number }[] = [];
  for (let i = 0; i < n; i++) {
    const u = await createUser(db, { nickname: `P${i}` });
    list.push({ id: u.id, gameId: await fx.game(gm.id) });
  }
  return { gm, list };
}

describe('publication in batches (Review Focus 1)', () => {
  it('10 session ratings from one rater in one game are one unit — nothing is published', async () => {
    const gm = await createUser(db);
    const p = await createUser(db);
    const g = await fx.game(gm.id);
    for (let i = 0; i < 10; i++) {
      const s = await fx.done(g, days(i), [p.id]);
      await insertRating(p.id, gm.id, g, { sessionId: s, overall: 5 });
    }
    expect(await publish(gm.id)).toBe(false);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
  });

  it('5 ratings from two people in two games (4 units) are not published', async () => {
    const gm = await createUser(db);
    const a = await createUser(db);
    const b = await createUser(db);
    const g1 = await fx.game(gm.id);
    const g2 = await fx.game(gm.id);
    const s1 = await fx.done(g1, days(1), [a.id, b.id]);
    await insertRating(a.id, gm.id, g1, { sessionId: s1 });
    await insertRating(a.id, gm.id, g1);
    await insertRating(b.id, gm.id, g1);
    await insertRating(a.id, gm.id, g2);
    await insertRating(b.id, gm.id, g2);
    expect(await publish(gm.id)).toBe(false);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
  });

  it('4 units → null, 5 → published, 9 → unchanged, 10 → a new snapshot', async () => {
    const { gm, list } = await raters(10);
    const scores = [5, 5, 4, 4, 3, 1, 1, 1, 1, 2];
    for (let i = 0; i < 4; i++) {
      await insertRating(list[i]!.id, gm.id, list[i]!.gameId, { overall: scores[i] });
      expect(await publish(gm.id)).toBe(false);
    }
    expect((await userRatings(deps, gm.id)).gm).toBeNull();

    await insertRating(list[4]!.id, gm.id, list[4]!.gameId, { overall: scores[4] });
    expect(await publish(gm.id)).toBe(true);
    const first = await snapshot(gm.id);
    expect(first).toMatchObject({ overall: 4.2, overallUnits: 5, units: 5 });
    expect((await userRatings(deps, gm.id)).gm).toEqual({ overall: 4.2, units: 5, criteria: {} });

    for (let i = 5; i < 9; i++) {
      await insertRating(list[i]!.id, gm.id, list[i]!.gameId, { overall: scores[i] });
      expect(await publish(gm.id)).toBe(false);
    }
    // 9 одиниць: зріз той самий, хоч середнє вже інше.
    expect((await userRatings(deps, gm.id)).gm).toEqual({ overall: 4.2, units: 5, criteria: {} });
    expect(await snapshot(gm.id)).toEqual(first);

    await insertRating(list[9]!.id, gm.id, list[9]!.gameId, { overall: scores[9] });
    expect(await publish(gm.id)).toBe(true);
    // (5+5+4+4+3+1+1+1+1+2) / 10 = 2.7
    expect((await userRatings(deps, gm.id)).gm).toEqual({ overall: 2.7, units: 10, criteria: {} });
    const second = await snapshot(gm.id);
    expect(second!.lastRatingId).toBeGreaterThan(first!.lastRatingId!);
  });

  it('a criterion with 4 units is hidden while the overall with 5 is shown; declines do not count', async () => {
    const { gm, list } = await raters(7);
    for (let i = 0; i < 5; i++) {
      await insertRating(list[i]!.id, gm.id, list[i]!.gameId, {
        overall: 4,
        criteria: i < 4 ? { preparation: 5, safety: 3 } : { preparation: 4 },
      });
    }
    // Відмови не входять ні в кількість, ні в середнє.
    await insertRating(list[5]!.id, gm.id, list[5]!.gameId, { declined: true });
    await insertRating(list[6]!.id, gm.id, list[6]!.gameId, { declined: true });
    expect(await publish(gm.id)).toBe(true);
    const dto = (await userRatings(deps, gm.id)).gm;
    expect(dto).toEqual({ overall: 4, units: 5, criteria: { preparation: 4.8 } });
    expect(await snapshot(gm.id)).toMatchObject({
      criteria: { preparation: { avg: 4.8, units: 5 }, safety: { avg: 3, units: 4 } },
    });
  });

  it('4 units plus declines are still null', async () => {
    const { gm, list } = await raters(6);
    for (let i = 0; i < 4; i++) await insertRating(list[i]!.id, gm.id, list[i]!.gameId);
    for (let i = 4; i < 6; i++) {
      await insertRating(list[i]!.id, gm.id, list[i]!.gameId, { declined: true });
    }
    expect(await publish(gm.id)).toBe(false);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
  });

  it('roles are published separately', async () => {
    const { gm, list } = await raters(5);
    for (const r of list) {
      await insertRating(r.id, gm.id, r.gameId, { role: 'player_from_player', overall: 3 });
    }
    expect(await publish(gm.id, 'gm')).toBe(false);
    expect(await publish(gm.id, 'player_from_player')).toBe(true);
    expect(await userRatings(deps, gm.id)).toEqual({
      gm: null,
      playerFromGm: null,
      playerFromPlayer: { overall: 3, units: 5, criteria: {} },
    });
  });
});

describe('concurrent submissions (Review Focus 4)', () => {
  /** Завершена гра: майстер і `n` гравців на одній сесії; кожен гравець — окрема одиниця. */
  async function finishedGame(n: number) {
    const gm = await createUser(db, { nickname: 'Майстер' });
    const g = await fx.game(gm.id, { status: 'finished', finishedAt: days(2) });
    const players = [];
    for (let i = 0; i < n; i++) {
      const u = await createUser(db, { nickname: `P${i}` });
      await fx.member(g, u.id, days(0));
      players.push(u);
    }
    await fx.done(
      g,
      days(1),
      players.map((p) => p.id),
    );
    return { gm, g, players };
  }
  const now = days(3);
  const rateGm = (raterId: number, g: number, gmPublicId: string, overall = 4) =>
    submitRating(deps, raterId, g, { rateeId: gmPublicId, overall }, now);

  it('parallel 9th and 10th ratings are not lost: the batch of 10 is published', async () => {
    const { gm, g, players } = await finishedGame(10);
    for (let i = 0; i < 5; i++) await rateGm(players[i]!.id, g, gm.publicId);
    expect((await snapshot(gm.id))!.units).toBe(5);
    for (let i = 5; i < 8; i++) await rateGm(players[i]!.id, g, gm.publicId);
    await Promise.all([
      rateGm(players[8]!.id, g, gm.publicId, 2),
      rateGm(players[9]!.id, g, gm.publicId, 2),
    ]);
    // Котра б не закомітилась другою, вона бачить обидві — пачка з 10 опублікована.
    expect(await snapshot(gm.id)).toMatchObject({ units: 10, overall: 3.6 });
    const published = await db.select().from(events).where(eq(events.type, 'rating.published'));
    expect(published).toHaveLength(2);
    for (const e of published) expect(e.payload).toEqual({ userId: gm.id, role: 'gm' });
  });

  it('parallel 5th and 6th: one snapshot of 5; the next batch includes both (10)', async () => {
    const { gm, g, players } = await finishedGame(10);
    for (let i = 0; i < 4; i++) await rateGm(players[i]!.id, g, gm.publicId);
    expect(await snapshot(gm.id)).toMatchObject({ units: 0, overall: null });
    await Promise.all([
      rateGm(players[4]!.id, g, gm.publicId, 5),
      rateGm(players[5]!.id, g, gm.publicId, 5),
    ]);
    expect((await snapshot(gm.id))!.units).toBe(5);
    for (let i = 6; i < 10; i++) await rateGm(players[i]!.id, g, gm.publicId);
    expect(await snapshot(gm.id)).toMatchObject({ units: 10, overall: 4.2 });
  });

  it('many parallel first ratings create one placeholder row without errors', async () => {
    const { gm, g, players } = await finishedGame(6);
    await Promise.all(players.map((p) => rateGm(p.id, g, gm.publicId)));
    expect((await snapshot(gm.id))!.units).toBe(5);
    expect(await db.select().from(ratings)).toHaveLength(6);
  });
});
