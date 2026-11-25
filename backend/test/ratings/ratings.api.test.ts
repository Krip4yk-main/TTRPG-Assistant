import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { events, ratings } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';
import { at, DAY, ratingFixtures } from './fixtures.js';

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

const ago = (d: number) => at(Date.now() - d * DAY);

async function user(nickname: string) {
  const u = await createUser(db, { nickname });
  return { ...u, cookie: await login(u.id) };
}

/** Кампанія: A і B на сесії вчора; гра завершена сьогодні (відкриті й сесійні, й підсумкові). */
async function setup(patch: Parameters<typeof fx.game>[1] = { status: 'finished' }) {
  const gm = await user('Майстер');
  const a = await user('Alpha');
  const b = await user('Beta');
  const gameId = await fx.game(gm.id, { finishedAt: ago(0), ...patch });
  await fx.member(gameId, a.id, ago(10));
  await fx.member(gameId, b.id, ago(10));
  const doneAt = ago(1);
  const sessionId = await fx.done(gameId, doneAt, [a.id, b.id]);
  return { gm, a, b, gameId, sessionId, doneAt };
}

const post = (gameId: number, cookie: string, body: object) =>
  call('post', `/api/games/${gameId}/ratings`, cookie, body);
const targets = (gameId: number, cookie: string, sessionId?: number) =>
  call(
    'get',
    `/api/games/${gameId}/ratings/targets${sessionId ? `?sessionId=${sessionId}` : ''}`,
    cookie,
  );

describe('POST /api/games/:id/ratings', () => {
  it('stores a rating with role derived from the game and kind from sessionId', async () => {
    const { gm, a, b, gameId, sessionId, doneAt } = await setup();
    const r1 = await post(gameId, a.cookie, {
      rateeId: gm.publicId,
      sessionId,
      overall: 5,
      criteria: { preparation: 4 },
      comment: '  Чудово  ',
    });
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({
      publicId: gm.publicId,
      nickname: 'Майстер',
      avatarUrl: null,
      role: 'gm',
      state: 'rated',
      closesAt: new Date(doneAt.getTime() + 14 * DAY).toISOString(),
    });
    expect((await post(gameId, gm.cookie, { rateeId: a.publicId, overall: 3 })).body.role).toBe(
      'player_from_gm',
    );
    expect(
      (await post(gameId, a.cookie, { rateeId: b.publicId, overall: 2, criteria: { respect: 1 } }))
        .body.role,
    ).toBe('player_from_player');
    const rows = await db.select().from(ratings).orderBy(ratings.id);
    expect(rows.map((r) => [r.kind, r.role, r.overall, r.sessionId])).toEqual([
      ['session', 'gm', 5, sessionId],
      ['final', 'player_from_gm', 3, null],
      ['final', 'player_from_player', 2, null],
    ]);
    expect(rows[0]).toMatchObject({ comment: 'Чудово', criteria: { preparation: 4 } });
    expect(rows[1]!.criteria).toBeNull();
    // Подія — без оцінювача.
    const ev = await db.select().from(events).where(eq(events.type, 'rating.created'));
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ userId: null, payload: { gameId } });
  });

  it('two parallel identical POSTs: one 201, one 409, one row (Review Focus 4)', async () => {
    const { gm, a, gameId } = await setup();
    const body = { rateeId: gm.publicId, overall: 4 };
    const res = await Promise.all([post(gameId, a.cookie, body), post(gameId, a.cookie, body)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.error.code).toBe('RATING_EXISTS');
    expect(await db.select().from(ratings)).toHaveLength(1);
  });

  it('decline shows as declined; rating afterwards is 409', async () => {
    const { gm, a, gameId, sessionId } = await setup();
    const d = await post(gameId, a.cookie, { rateeId: gm.publicId, sessionId, declined: true });
    expect(d.status).toBe(201);
    expect(d.body.state).toBe('declined');
    const t = await targets(gameId, a.cookie, sessionId);
    expect(t.status).toBe(200);
    expect(t.body.targets.find((x: { publicId: string }) => x.publicId === gm.publicId).state).toBe(
      'declined',
    );
    const again = await post(gameId, a.cookie, { rateeId: gm.publicId, sessionId, overall: 5 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RATING_EXISTS');
    const [row] = await db.select().from(ratings);
    expect(row).toMatchObject({ declined: true, overall: null, criteria: null, comment: null });
  });

  it('player criterion in a GM rating → 400; invalid body → 400', async () => {
    const { gm, a, b, gameId } = await setup();
    const bad = await post(gameId, a.cookie, {
      rateeId: gm.publicId,
      overall: 5,
      criteria: { punctuality: 5 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('RATING_CRITERIA_INVALID');
    const gmCrit = await post(gameId, a.cookie, {
      rateeId: b.publicId,
      overall: 5,
      criteria: { safety: 5 },
    });
    expect(gmCrit.body.error.code).toBe('RATING_CRITERIA_INVALID');
    // `kind` не приймається з тіла; загальна обов'язкова.
    const kind = await post(gameId, a.cookie, { rateeId: gm.publicId, overall: 5, kind: 'final' });
    expect(kind.status).toBe(400);
    expect((await post(gameId, a.cookie, { rateeId: gm.publicId })).status).toBe(400);
    expect(await db.select().from(ratings)).toHaveLength(0);
  });

  it('hidden or unknown game → 404; stranger → 403; foreign session → 404', async () => {
    const { gm, a, gameId } = await setup();
    const hidden = await fx.game(gm.id, { status: 'draft', publishedAt: null });
    await fx.member(hidden, a.id, ago(5));
    expect((await post(hidden, a.cookie, { rateeId: gm.publicId, overall: 5 })).status).toBe(404);
    expect((await targets(hidden, a.cookie)).status).toBe(404);
    expect((await targets(999_999, a.cookie)).status).toBe(404);
    const stranger = await user('Stranger');
    const t = await targets(gameId, stranger.cookie);
    expect(t.status).toBe(403);
    expect(t.body.error.code).toBe('RATING_NOT_ALLOWED');
    const s = await post(gameId, stranger.cookie, { rateeId: gm.publicId, overall: 5 });
    expect(s.body.error.code).toBe('RATING_NOT_ALLOWED');
    const other = await fx.game(gm.id);
    const foreign = await fx.done(other, ago(1), [a.id]);
    expect((await targets(gameId, a.cookie, foreign)).status).toBe(404);
    expect(
      (await post(gameId, a.cookie, { rateeId: gm.publicId, sessionId: foreign, overall: 5 }))
        .status,
    ).toBe(404);
    expect(
      (await call('get', `/api/games/${gameId}/ratings/targets?sessionId=abc`, a.cookie)).status,
    ).toBe(400);
  });

  it('requires auth and CSRF', async () => {
    const { gm, a, gameId } = await setup();
    expect((await call('get', `/api/games/${gameId}/ratings/targets`)).status).toBe(401);
    expect((await call('get', '/api/me/ratings/pending')).status).toBe(401);
    const noCsrf = await request(app)
      .post(`/api/games/${gameId}/ratings`)
      .set('Cookie', a.cookie)
      .send({ rateeId: gm.publicId, overall: 5 });
    expect(noCsrf.status).toBe(403);
  });
});

describe('GET /api/me/ratings/pending', () => {
  it('lists open sets for the user', async () => {
    const { gm, a, b, gameId, sessionId } = await setup();
    const res = await call('get', '/api/me/ratings/pending', a.cookie);
    expect(res.status).toBe(200);
    expect(
      res.body.map((s: { sessionId: number | null; kind: string; targets: unknown[] }) => [
        s.sessionId,
        s.kind,
        s.targets.length,
      ]),
    ).toEqual([
      [sessionId, 'session', 2],
      [null, 'final', 2],
    ]);
    for (const p of [gm, b]) {
      await post(gameId, a.cookie, { rateeId: p.publicId, sessionId, declined: true });
    }
    const after = await call('get', '/api/me/ratings/pending', a.cookie);
    expect(after.body.map((s: { kind: string }) => s.kind)).toEqual(['final']);
  });
});
