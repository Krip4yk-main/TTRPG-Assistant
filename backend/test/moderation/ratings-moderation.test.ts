import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  events,
  moderationLog,
  notifications,
  publishedRatings,
  ratings,
  users,
} from '../../src/db/schema/index.js';
import { lockPublished, maybePublish, userRatings } from '../../src/ratings/ratings.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { bornYearsAgo, harness } from '../games/fixtures.js';
import { ratingFixtures } from '../ratings/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { login, call } = harness(deps, app);
const fx = ratingFixtures(db);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

type Role = 'user' | 'moderator' | 'admin' | 'owner';

let seq = 0;
async function user(nickname = `U${++seq}`, role: Role = 'user') {
  const u = await createUser(db, { nickname, role, birthDate: bornYearsAgo(30) });
  return { ...u, cookie: await login(u.id) };
}

/**
 * Майстер з `n` оцінками `gm` від різних гравців (overall — з `scores`); перші `published`
 * публікуються пачкою (`maybePublish` після кожної вставки, як у `submitRating`).
 */
async function gmWithRatings(scores: number[], opts: { publishAfter?: number } = {}) {
  const gm = await user('Gm');
  const gameId = await fx.game(gm.id);
  const ids: number[] = [];
  const raters: number[] = [];
  for (const [i, overall] of scores.entries()) {
    const rater = await createUser(db, { nickname: `Rater${i}` });
    raters.push(rater.id);
    const [r] = await db
      .insert(ratings)
      .values({
        raterId: rater.id,
        rateeId: gm.id,
        gameId,
        kind: 'final',
        role: 'gm',
        overall,
        comment: i === 0 ? 'Майстер запізнився' : null,
      })
      .$returningId();
    ids.push(r!.id);
    if (opts.publishAfter === undefined || i < opts.publishAfter) {
      await db.transaction((tx) => maybePublish(tx, gm.id, 'gm'));
    }
  }
  return { gm, gameId, ids, raters };
}

const queue = (cookie: string, qs = '') => call('get', `/api/admin/ratings${qs}`, cookie);
const hide = (cookie: string, id: number, reason = 'Образа') =>
  call('post', `/api/admin/ratings/${id}/hide-text`, cookie, { reason });
const cancel = (cookie: string, id: number, reason = 'Помста') =>
  call('post', `/api/admin/ratings/${id}/cancel`, cookie, { reason });

describe('GET /api/admin/ratings', () => {
  it('staff see texts and both nicknames; filters new/commented; user → 403', async () => {
    const mod = await user('Mod', 'moderator');
    const { gm, ids } = await gmWithRatings([5, 4]);
    const all = await queue(mod.cookie);
    expect(all.status).toBe(200);
    expect(all.body.items.map((r: { id: number }) => r.id)).toEqual([ids[1], ids[0]]);
    expect(all.body.items[1]).toMatchObject({
      rater: { nickname: 'Rater0' },
      ratee: { publicId: gm.publicId, nickname: 'Gm' },
      overall: 5,
      comment: 'Майстер запізнився',
      moderated: 'none',
      kind: 'final',
      role: 'gm',
    });
    const commented = await queue(mod.cookie, '?filter=commented');
    expect(commented.body.items.map((r: { id: number }) => r.id)).toEqual([ids[0]]);
    const page = await queue(mod.cookie, '?limit=1');
    expect(page.body.nextCursor).toBe(ids[1]);
    expect((await queue(mod.cookie, `?cursor=${ids[1]}`)).body.items).toHaveLength(1);
    expect((await queue(gm.cookie)).status).toBe(403);
    expect((await queue(mod.cookie, '?filter=bad')).status).toBe(400);
  });

  it('RF 2: a staff member never sees ratings about themselves (rater stays anonymous)', async () => {
    const { gm, ids } = await gmWithRatings([5]);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, gm.id));
    const cookie = await login(gm.id);
    expect((await queue(cookie)).body.items).toEqual([]);
    expect((await cancel(cookie, ids[0]!)).status).toBe(403);
  });
});

describe('hide text', () => {
  it('hides the text: leaves the queue, score unchanged, text kept in the log only', async () => {
    const mod = await user('Mod', 'moderator');
    const { gm, ids } = await gmWithRatings([5, 4, 4, 4, 3]);
    const before = await userRatings(deps, gm.id);
    const res = await hide(mod.cookie, ids[0]!, 'Образливий текст');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids[0], moderated: 'text_hidden', comment: null });
    expect((await queue(mod.cookie, '?filter=commented')).body.items).toEqual([]);
    expect((await queue(mod.cookie)).body.items.map((r: { id: number }) => r.id)).not.toContain(
      ids[0],
    );
    expect(await userRatings(deps, gm.id)).toEqual(before);
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({
      actorId: mod.id,
      action: 'rating.hide_text',
      targetType: 'rating',
      targetId: ids[0],
      reason: 'Образливий текст',
    });
    expect(log!.meta).toMatchObject({ comment: 'Майстер запізнився' });
    // Повторно / оцінка без тексту → 409.
    expect((await hide(mod.cookie, ids[0]!)).body.error.code).toBe('RATING_ALREADY_MODERATED');
    expect((await hide(mod.cookie, ids[1]!)).status).toBe(409);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('RF 2: the hidden text in the log is not shown to the rated staff member', async () => {
    const mod = await user('Mod', 'moderator');
    const owner = await user('Owner', 'owner');
    const { gm, ids } = await gmWithRatings([5]);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, gm.id));
    expect((await hide(mod.cookie, ids[0]!)).status).toBe(200);
    const asRatee = await call('get', '/api/admin/log', await login(gm.id));
    expect(asRatee.status).toBe(200);
    expect(asRatee.body.items[0].meta).toEqual({ role: 'gm', kind: 'final' });
    const asOwner = await call('get', '/api/admin/log', owner.cookie);
    expect(asOwner.body.items[0].meta.comment).toBe('Майстер запізнився');
  });
});

describe('cancel rating', () => {
  it('republishes immediately without the cancelled unit; author and ratee not notified', async () => {
    const mod = await user('Mod', 'moderator');
    // 10 одиниць опубліковано другою пачкою: середнє 4.
    const { gm, ids } = await gmWithRatings([1, 5, 5, 5, 4, 4, 4, 4, 4, 4]);
    const profile = () => call('get', `/api/users/${gm.publicId}`, gm.cookie);
    expect((await profile()).body.ratings.gm).toMatchObject({ overall: 4, units: 10 });
    const evBefore = (await db.select().from(events)).length;

    const res = await cancel(mod.cookie, ids[0]!, 'Помста після конфлікту');
    expect(res.status).toBe(200);
    expect(res.body.moderated).toBe('cancelled');
    // (5·3 + 4·6) / 9 = 4.33 — одразу, без нової пачки.
    expect((await profile()).body.ratings.gm).toMatchObject({ overall: 4.3, units: 9 });
    expect(await db.select().from(notifications)).toEqual([]);
    expect((await db.select().from(events)).length).toBe(evBefore);
    const [log] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.action, 'rating.cancel'));
    expect(log).toMatchObject({
      actorId: mod.id,
      targetId: ids[0],
      reason: 'Помста після конфлікту',
    });
    expect((await cancel(mod.cookie, ids[0]!)).body.error.code).toBe('RATING_ALREADY_MODERATED');
    // Анульована зникла з черги.
    const left = (await queue(mod.cookie)).body.items.map((r: { id: number }) => r.id);
    expect(left).not.toContain(ids[0]);
  });

  it('fewer than 5 units after cancel → hidden; the baseline stays, next publish needs 5 new units', async () => {
    const mod = await user('Mod', 'moderator');
    const { gm, gameId, ids } = await gmWithRatings([5, 5, 5, 5, 1]);
    expect((await userRatings(deps, gm.id)).gm).toMatchObject({ overall: 4.2, units: 5 });
    expect((await cancel(mod.cookie, ids[4]!)).status).toBe(200);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
    const [snap] = await db.select().from(publishedRatings);
    expect(snap).toMatchObject({ units: 4, overall: null, lastRatingId: ids[4] });
    const rate = async (overall: number) => {
      const r = await createUser(db, { nickname: `Late${++seq}` });
      await db
        .insert(ratings)
        .values({ raterId: r.id, rateeId: gm.id, gameId, kind: 'final', role: 'gm', overall });
      return db.transaction((tx) => maybePublish(tx, gm.id, 'gm'));
    };
    // 4 нові — ще не пачка (анульована не рахується ні в базі, ні в нових).
    for (let i = 0; i < 4; i++) expect(await rate(3)).toBe(false);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
    expect(await rate(3)).toBe(true);
    // (5·4 + 3·5) / 9 = 3.89
    expect((await userRatings(deps, gm.id)).gm).toMatchObject({ overall: 3.9, units: 9 });
  });

  it('RF 2: republish uses only the published batch — new unpublished ratings stay hidden', async () => {
    const mod = await user('Mod', 'moderator');
    // 5 опубліковано (середнє 3), ще 3 нові (по 5) чекають своєї пачки.
    const { gm, ids } = await gmWithRatings([3, 3, 3, 3, 3, 5, 5, 5], { publishAfter: 5 });
    await db.transaction((tx) => maybePublish(tx, gm.id, 'gm'));
    expect((await userRatings(deps, gm.id)).gm).toMatchObject({ overall: 3, units: 5 });
    // Анулювання опублікованої: у межах зрізу лишається 4 → сховано (нові 5-ки не «спливли»).
    await cancel(mod.cookie, ids[0]!);
    expect((await userRatings(deps, gm.id)).gm).toBeNull();
  });

  it('RF 2: cancelling an unpublished rating leaves the published snapshot as it was', async () => {
    const mod = await user('Mod', 'moderator');
    const { gm, ids } = await gmWithRatings([3, 3, 3, 3, 3, 1], { publishAfter: 5 });
    const before = await db.select().from(publishedRatings);
    await cancel(mod.cookie, ids[5]!);
    const after = await db.select().from(publishedRatings);
    const strip = (rows: typeof before) => rows.map((r) => ({ ...r, publishedAt: null }));
    expect(strip(after)).toEqual(strip(before));
    expect((await userRatings(deps, gm.id)).gm).toMatchObject({ overall: 3, units: 5 });
  });

  it('rank: a moderator cannot moderate a rating written by an admin; unknown → 404', async () => {
    const mod = await user('Mod', 'moderator');
    const admin = await user('Admin', 'admin');
    const { ids, raters } = await gmWithRatings([5]);
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, raters[0]!));
    const r = await cancel(mod.cookie, ids[0]!);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await hide(admin.cookie, ids[0]!)).status).toBe(403);
    // У черзі — лише оцінки від людей з нижчою роллю.
    expect((await queue(mod.cookie)).body.items).toEqual([]);
    expect((await queue(admin.cookie)).body.items).toEqual([]);
    const owner = await user('Owner', 'owner');
    expect((await queue(owner.cookie)).body.items.map((x: { id: number }) => x.id)).toEqual([
      ids[0],
    ]);
    expect((await cancel(mod.cookie, 999_999)).status).toBe(404);
    expect((await cancel(mod.cookie, ids[0]!, '')).status).toBe(400);
  });

  it('concurrent publish + cancel: the cancel sees the batch committed while it waited', async () => {
    const mod = await user('Mod', 'moderator');
    // 5 опубліковано (межа — 5-та), ще 4 чекають пачки.
    const { gm, gameId, ids } = await gmWithRatings([3, 3, 3, 3, 3, 4, 4, 4, 4], {
      publishAfter: 5,
    });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lastId = 0;
    // Інша транзакція тримає лок зрізу, додає 10-ту оцінку й публікує пачку.
    const publish = db.transaction(async (tx) => {
      await lockPublished(tx, gm.id, 'gm');
      locked();
      await gate;
      const r = await createUser(db, { nickname: 'Tenth' });
      const [res] = await tx
        .insert(ratings)
        .values({ raterId: r.id, rateeId: gm.id, gameId, kind: 'final', role: 'gm', overall: 4 })
        .$returningId();
      lastId = res!.id;
      expect(await maybePublish(tx, gm.id, 'gm')).toBe(true);
    });
    await lockedP;
    const cancelled = cancel(mod.cookie, ids[0]!);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await publish;
    expect((await cancelled).status).toBe(200);
    const [snap] = await db.select().from(publishedRatings);
    // Межа — 10-та оцінка; без анульованої — 9 одиниць: (3·4 + 4·5) / 9 = 3.56.
    expect(snap).toMatchObject({ lastRatingId: lastId, units: 9 });
    expect((await userRatings(deps, gm.id)).gm).toMatchObject({ overall: 3.6, units: 9 });
  });
});
