import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RatingInput } from '@nri/shared';
import { users } from '../../src/db/schema/index.js';
import {
  pendingRatings,
  playedTogether,
  ratingTargets,
} from '../../src/ratings/ratings.eligibility.js';
import { submitRating } from '../../src/ratings/ratings.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { at, DAY, MIN, ratingFixtures } from './fixtures.js';

const deps = await testDeps();
const { db } = deps;
const fx = ratingFixtures(db);

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

const T0 = at(Date.UTC(2026, 5, 1, 12));
const days = (n: number) => at(T0.getTime() + n * DAY);

async function people() {
  const gm = await createUser(db, { nickname: 'Майстер' });
  const a = await createUser(db, { nickname: 'Alpha' });
  const b = await createUser(db, { nickname: 'Beta' });
  return { gm, a, b };
}

type U = { id: number; publicId: string };
const ids = (t: { targets: { publicId: string }[] }) => t.targets.map((x) => x.publicId);
const rate = (rater: U, gameId: number, ratee: U, now: Date, extra: Partial<RatingInput> = {}) =>
  submitRating(deps, rater.id, gameId, { rateeId: ratee.publicId, overall: 4, ...extra }, now);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { status?: number; code?: string }) => `${e.status} ${e.code}`,
  );

describe('played together (Review Focus 2)', () => {
  it('a player who joined after another left cannot rate them, nor vice versa', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, b.id, days(0), days(5));
    await fx.done(g, days(3), [b.id]);
    await fx.member(g, a.id, days(6));
    await fx.done(g, days(10), [a.id]);
    const now = days(11);

    expect(await playedTogether(db, g, a.id, b.id)).toBe(false);
    expect(await playedTogether(db, g, a.id, gm.id)).toBe(true);
    expect(await playedTogether(db, g, b.id, gm.id)).toBe(true);
    // B вийшов — його підсумкова (вихідна) відкрита лише з майстром.
    expect(ids(await ratingTargets(deps, b.id, g, null, now))).toEqual([gm.publicId]);
    // A не грав з B, а з майстром — обидва ще в грі, що йде: підсумкової немає.
    expect(ids(await ratingTargets(deps, a.id, g, null, now))).toEqual([]);
    expect(await code(rate(a, g, b, now))).toBe('403 RATING_NOT_ALLOWED');
    expect(await code(rate(b, g, a, now))).toBe('403 RATING_NOT_ALLOWED');
    expect(await code(rate(b, g, gm, now))).toBe('ok');
  });

  it('who left before the first session rates nobody and is rated by nobody', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, a.id, days(0));
    await fx.member(g, b.id, days(0), days(1));
    await fx.done(g, days(3), [a.id]);
    const now = days(4);
    expect((await ratingTargets(deps, b.id, g, null, now)).targets).toEqual([]);
    expect(await code(rate(b, g, gm, now))).toBe('403 RATING_NOT_ALLOWED');
    expect(await code(rate(gm, g, b, now))).toBe('403 RATING_NOT_ALLOWED');
    expect(await pendingRatings(deps, b.id, now)).toEqual([]);
  });

  it('GM rates present session members, not absent ones; absent members rate nobody', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, a.id, days(0));
    await fx.member(g, b.id, days(0));
    const s = await fx.done(g, days(3), [a.id], [b.id]);
    const now = days(4);
    const t = await ratingTargets(deps, gm.id, g, s, now);
    expect(t).toMatchObject({ gameId: g, sessionId: s, kind: 'session' });
    expect(t.targets).toEqual([
      {
        publicId: a.publicId,
        nickname: 'Alpha',
        avatarUrl: null,
        role: 'player_from_gm',
        state: 'open',
        closesAt: days(17).toISOString(),
      },
    ]);
    expect(await code(rate(gm, g, b, now, { sessionId: s }))).toBe('403 RATING_NOT_ALLOWED');
    expect((await ratingTargets(deps, b.id, g, s, now)).targets).toEqual([]);
    expect(await code(rate(b, g, gm, now, { sessionId: s }))).toBe('403 RATING_NOT_ALLOWED');
    // Присутній гравець: майстер першим, роль — gm.
    const pa = await ratingTargets(deps, a.id, g, s, now);
    expect(pa.targets.map((x) => [x.publicId, x.role])).toEqual([[gm.publicId, 'gm']]);
    // Гра йде, ніхто не виходив — підсумкових цілей немає.
    expect((await ratingTargets(deps, a.id, g, null, now)).targets).toEqual([]);
    expect(await code(rate(a, g, gm, now))).toBe('403 RATING_NOT_ALLOWED');
  });

  it('cannot rate self; deleted account is not a target', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id, { status: 'finished', finishedAt: days(5) });
    await fx.member(g, a.id, days(0));
    await fx.member(g, b.id, days(0));
    await fx.done(g, days(3), [a.id, b.id]);
    const now = days(6);
    expect(await code(rate(a, g, a, now))).toBe('403 RATING_NOT_ALLOWED');
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, b.id));
    expect(ids(await ratingTargets(deps, a.id, g, null, now))).toEqual([gm.publicId]);
    expect(await code(rate(a, g, b, now))).toBe('403 RATING_NOT_ALLOWED');
  });

  it('finished oneshot without recorded attendance: members at finish rate each other', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id, { kind: 'oneshot', status: 'finished', finishedAt: days(3) });
    await fx.member(g, a.id, days(0));
    await fx.member(g, b.id, days(0));
    const s = await fx.done(g, days(3));
    const now = days(4);
    const t = await ratingTargets(deps, a.id, g, null, now);
    expect(t.targets.map((x) => [x.publicId, x.role])).toEqual([
      [gm.publicId, 'gm'],
      [b.publicId, 'player_from_player'],
    ]);
    // У ваншота немає окремої сесійної оцінки.
    expect((await ratingTargets(deps, a.id, g, s, now)).targets).toEqual([]);
    expect(await code(rate(a, g, b, now, { sessionId: s }))).toBe('403 RATING_NOT_ALLOWED');
  });
});

describe('windows (Review Focus 3)', () => {
  it('session window: 14 days minus a minute open, plus a minute closed', async () => {
    const { gm, a } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, a.id, days(0));
    const s = await fx.done(g, days(1), [a.id]);
    const closes = days(15).getTime();
    const before = new Date(closes - MIN);
    const after = new Date(closes + MIN);
    expect(ids(await ratingTargets(deps, a.id, g, s, before))).toEqual([gm.publicId]);
    expect((await ratingTargets(deps, a.id, g, s, after)).targets).toEqual([]);
    expect(await code(rate(a, g, gm, after, { sessionId: s }))).toBe('409 RATING_WINDOW_CLOSED');
    expect(await code(rate(a, g, gm, before, { sessionId: s }))).toBe('ok');
  });

  it('final window: 30 days after finish', async () => {
    const { gm, a } = await people();
    const g = await fx.game(gm.id, { status: 'finished', finishedAt: days(10) });
    await fx.member(g, a.id, days(0));
    await fx.done(g, days(5), [a.id]);
    const closes = days(40).getTime();
    const t = await ratingTargets(deps, gm.id, g, null, new Date(closes - MIN));
    expect(t.targets.map((x) => [x.publicId, x.closesAt])).toEqual([
      [a.publicId, days(40).toISOString()],
    ]);
    expect(await code(rate(gm, g, a, new Date(closes + MIN)))).toBe('409 RATING_WINDOW_CLOSED');
    expect(await code(rate(gm, g, a, new Date(closes - MIN)))).toBe('ok');
  });

  it('leave rating stays open while the campaign runs, without a deadline', async () => {
    const { gm, a, b } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, a.id, days(0));
    await fx.member(g, b.id, days(0), days(5));
    await fx.done(g, days(2), [a.id, b.id]);
    const now = days(400);
    const t = await ratingTargets(deps, a.id, g, null, now);
    expect(t.targets).toEqual([expect.objectContaining({ publicId: b.publicId, closesAt: null })]);
    const left = await ratingTargets(deps, b.id, g, null, now);
    expect(ids(left)).toEqual([gm.publicId, a.publicId]);
    // Ще до виходу (now < left_at) — не «вихідна».
    expect((await ratingTargets(deps, a.id, g, null, days(4))).targets).toEqual([]);
    expect(await code(rate(a, g, b, now))).toBe('ok');
  });

  it('leave rating closes 30 days after cancellation; cancelled game has no final otherwise', async () => {
    const { gm, a, b } = await people();
    const c = await createUser(db, { nickname: 'Gamma' });
    const g = await fx.game(gm.id, { status: 'cancelled', cancelledAt: days(10) });
    await fx.member(g, a.id, days(0));
    await fx.member(g, c.id, days(0));
    await fx.member(g, b.id, days(0), days(5));
    await fx.done(g, days(2), [a.id, b.id, c.id]);
    const closes = days(40).getTime();
    const before = new Date(closes - MIN);
    const after = new Date(closes + MIN);
    // Скасована гра: лише пари з тим, хто вийшов.
    expect(ids(await ratingTargets(deps, a.id, g, null, before))).toEqual([b.publicId]);
    expect(await code(rate(a, g, c, before))).toBe('403 RATING_NOT_ALLOWED');
    expect(await code(rate(a, g, b, after))).toBe('409 RATING_WINDOW_CLOSED');
    expect(await code(rate(a, g, b, before))).toBe('ok');
  });

  it('cancelled game where nobody left: no final targets', async () => {
    const { gm, a } = await people();
    const g = await fx.game(gm.id, { status: 'cancelled', cancelledAt: days(10) });
    await fx.member(g, a.id, days(0));
    await fx.done(g, days(2), [a.id]);
    expect((await ratingTargets(deps, a.id, g, null, days(11))).targets).toEqual([]);
    expect(await code(rate(a, g, gm, days(11)))).toBe('403 RATING_NOT_ALLOWED');
  });
});

describe('submission and pending', () => {
  it('rejoined after leaving: the final rating given at leave stays, a repeat is 409', async () => {
    const { gm, a } = await people();
    const g = await fx.game(gm.id);
    await fx.member(g, a.id, days(0), days(5));
    await fx.done(g, days(2), [a.id]);
    expect(await code(rate(a, g, gm, days(6)))).toBe('ok');
    await fx.member(g, a.id, days(7));
    const t = await ratingTargets(deps, a.id, g, null, days(8));
    expect(t.targets.map((x) => x.state)).toEqual(['rated']);
    expect(await code(rate(a, g, gm, days(8)))).toBe('409 RATING_EXISTS');
  });

  it('pending lists only sets with an open target, nearest deadline first', async () => {
    const { gm, a, b } = await people();
    const g1 = await fx.game(gm.id, { status: 'finished', finishedAt: days(20) });
    await fx.member(g1, a.id, days(0));
    const s1 = await fx.done(g1, days(15), [a.id]);
    const g2 = await fx.game(gm.id);
    await fx.member(g2, a.id, days(0));
    await fx.member(g2, b.id, days(0), days(3));
    await fx.done(g2, days(1), [a.id, b.id]);
    await fx.done(g2, days(2), [a.id]);
    const now = days(21);
    const p = await pendingRatings(deps, a.id, now);
    expect(p.map((x) => [x.gameId, x.sessionId, ids(x)])).toEqual([
      [g1, s1, [gm.publicId]],
      [g1, null, [gm.publicId]],
      [g2, null, [b.publicId]],
    ]);
    expect(p[2]!.targets[0]!.closesAt).toBeNull();
    // Оцінив усіх у наборі — набір зникає.
    await rate(a, g1, gm, now, { sessionId: s1 });
    await submitRating(deps, a.id, g2, { rateeId: b.publicId, declined: true }, now);
    expect((await pendingRatings(deps, a.id, now)).map((x) => [x.gameId, x.sessionId])).toEqual([
      [g1, null],
    ]);
  });
});
