import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { contentWarnings, events, gameSystems, games, users } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, validGame, call, createGame } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

describe('games lifecycle', () => {
  it('creates a draft with the GM timezone and publishes it to recruiting', async () => {
    const gm = await userWithAge(30, 'Master');
    const created = await call('post', '/api/games', gm.cookie, await validGame());
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.timezone).toBe('Europe/Kyiv');
    expect(created.body.gm.nickname).toBe('Master');
    const id = created.body.id as number;

    const pub = await call('post', `/api/games/${id}/publish`, gm.cookie);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe('recruiting');
    expect(pub.body.publishedAt).toEqual(expect.any(String));
    expect(pub.body.nextSessionAt).toBe(created.body.startsAt);
    expect(pub.body.freeSlots).toBe(5);

    const types = (await db.select({ type: events.type }).from(events)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['game.created', 'game.published']));
  });

  it('publishing with startsAt in the past → 422 GAME_IN_PAST', async () => {
    const gm = await userWithAge(30);
    // 2020-01-06 — понеділок.
    const id = await createGame(gm.cookie, { startsAt: '2020-01-06T17:00:00.000Z' });
    const res = await call('post', `/api/games/${id}/publish`, gm.cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GAME_IN_PAST');
  });

  it('runs start → finish; invalid transitions → 409', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    const bad = await call('post', `/api/games/${id}/finish`, gm.cookie);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('GAME_INVALID_TRANSITION');
    expect((await call('post', `/api/games/${id}/start`, gm.cookie)).body.status).toBe('started');
    expect((await call('post', `/api/games/${id}/finish`, gm.cookie)).body.status).toBe('finished');
    const cancel = await call('post', `/api/games/${id}/cancel`, gm.cookie);
    expect(cancel.status).toBe(409);
    const types = (await db.select({ type: events.type }).from(events)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['game.started', 'game.finished']));
  });

  it('cancels a draft; cancelled game cannot be edited', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie);
    const res = await call('post', `/api/games/${id}/cancel`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    const patch = await call('patch', `/api/games/${id}`, gm.cookie, { title: 'x' });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('GAME_INVALID_TRANSITION');
  });

  it('only the GM can run transitions', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    const res = await call('post', `/api/games/${id}/start`, other.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /mine lists own games in all statuses', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const draft = await createGame(gm.cookie);
    const pub = await createGame(gm.cookie, {}, true);
    await createGame(other.cookie, {}, true);
    const res = await call('get', '/api/games/mine', gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body.map((g: { id: number }) => g.id).sort()).toEqual([draft, pub].sort());
    expect(res.body[0]).toHaveProperty('freeSlots');
  });

  it('pending user cannot create a game', async () => {
    const gm = await userWithAge(30);
    await db.update(users).set({ status: 'pending' });
    const res = await call('post', '/api/games', gm.cookie, await validGame());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
  });
});

describe('games edit locks', () => {
  it('PATCH systemId in recruiting → 409 GAME_FIELD_LOCKED {field:systemId}', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    const [, other] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(2);
    const res = await call('patch', `/api/games/${id}`, gm.cookie, { systemId: other!.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'GAME_FIELD_LOCKED', details: { field: 'systemId' } });
    const kind = await call('patch', `/api/games/${id}`, gm.cookie, {
      kind: 'oneshot',
      recurrence: 'none',
      weekdays: [],
    });
    expect(kind.status).toBe(409);
    expect(kind.body.error.details).toEqual({ field: 'kind' });
  });

  it('PATCH title in recruiting → 200; sending an unchanged locked field is fine', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    const res = await call('patch', `/api/games/${id}`, gm.cookie, {
      title: 'Нова назва',
      systemId: row!.systemId,
    });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Нова назва');
    expect(res.body.status).toBe('recruiting');
  });

  it('in draft everything can change', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie);
    const res = await call('patch', `/api/games/${id}`, gm.cookie, {
      systemId: null,
      systemOther: 'Homebrew',
      kind: 'oneshot',
      recurrence: 'none',
      weekdays: [],
      format: 'offline',
      city: 'Львів',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      system: null,
      systemOther: 'Homebrew',
      kind: 'oneshot',
      city: 'Львів',
    });
  });

  it('PATCH validates the merged game', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie);
    const res = await call('patch', `/api/games/${id}`, gm.cookie, { format: 'offline' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('non-GM PATCH → 403', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    const res = await call('patch', `/api/games/${id}`, other.cookie, { title: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('games age and validation', () => {
  it('16-year-old GM cannot create an 18+ game → 403 AGE_RESTRICTED_CREATE', async () => {
    const gm = await userWithAge(16);
    const res = await call('post', '/api/games', gm.cookie, await validGame({ ageRating: '18+' }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AGE_RESTRICTED_CREATE');
  });

  it('16-year-old GM cannot patch a game to 18+; 19-year-old cannot create 21+', async () => {
    const young = await userWithAge(16);
    const id = await createGame(young.cookie);
    const res = await call('patch', `/api/games/${id}`, young.cookie, { ageRating: '18+' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AGE_RESTRICTED_CREATE');
    const gm19 = await userWithAge(19);
    const r21 = await call(
      'post',
      '/api/games',
      gm19.cookie,
      await validGame({ ageRating: '21+' }),
    );
    expect(r21.status).toBe(403);
    const r18 = await call(
      'post',
      '/api/games',
      gm19.cookie,
      await validGame({ ageRating: '18+' }),
    );
    expect(r18.status).toBe(201);
  });

  it.each([
    ['oneshot with weekly', { kind: 'oneshot', recurrence: 'weekly' }],
    ['offline without city', { format: 'offline' }],
    ['http cover', { coverUrl: 'http://img.test/a.png' }],
    ['startsAt weekday not in weekdays', { weekdays: [3] }],
    ['client-supplied timezone', { timezone: 'Europe/London' }],
  ])('%s → 400 VALIDATION', async (_name, patch) => {
    const gm = await userWithAge(30);
    const res = await call('post', '/api/games', gm.cookie, await validGame(patch));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('unknown catalog ids → 400 VALIDATION', async () => {
    const gm = await userWithAge(30);
    const res = await call('post', '/api/games', gm.cookie, await validGame({ genreId: 99999 }));
    expect(res.status).toBe(400);
    const w = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({ contentWarningIds: [99999] }),
    );
    expect(w.status).toBe(400);
  });

  it('stores content warnings and returns them', async () => {
    const gm = await userWithAge(30);
    const ws = await db.select({ id: contentWarnings.id }).from(contentWarnings).limit(2);
    const ids = ws.map((w) => w.id).sort((a, b) => a - b);
    const res = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({ contentWarningIds: ids, customWarnings: ['павуки'] }),
    );
    expect(res.status).toBe(201);
    expect(res.body.contentWarningIds).toEqual(ids);
    expect(res.body.customWarnings).toEqual(['павуки']);
  });
});
