import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { gameMembers } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const RESTRICTED_KEYS = ['ageRating', 'gm', 'id', 'restricted', 'title'];

describe('games visibility — drafts and private fields (Review Focus 4)', () => {
  it("someone else's draft → 404 (guest and other user); GM sees it", async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const id = await createGame(gm.cookie);
    expect((await call('get', `/api/games/${id}`)).status).toBe(404);
    expect((await call('get', `/api/games/${id}`, other.cookie)).status).toBe(404);
    expect((await call('patch', `/api/games/${id}`, other.cookie, { title: 'x' })).status).toBe(
      404,
    );
    const own = await call('get', `/api/games/${id}`, gm.cookie);
    expect(own.status).toBe(200);
    expect(own.body.status).toBe('draft');
  });

  it('address/channelLinks: absent for outsiders, present for GM and members', async () => {
    const gm = await userWithAge(30);
    const outsider = await userWithAge(30);
    const member = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    await db.insert(gameMembers).values({ gameId: id, userId: member.id });

    const out = (await call('get', `/api/games/${id}`, outsider.cookie)).body;
    expect(out.title).toBeDefined();
    expect(out.description).toBe('Готичний жах');
    expect('address' in out).toBe(false);
    expect('channelLinks' in out).toBe(false);
    const guest = (await call('get', `/api/games/${id}`)).body;
    expect('address' in guest).toBe(false);
    expect('channelLinks' in guest).toBe(false);

    for (const viewer of [gm, member]) {
      const body = (await call('get', `/api/games/${id}`, viewer.cookie)).body;
      expect(body.address).toBe('вул. Таємна, 1');
      expect(body.channelLinks).toEqual([{ label: 'Discord', url: 'https://discord.gg/abc' }]);
    }
    expect((await call('get', `/api/games/${id}`, member.cookie)).body.freeSlots).toBe(4);
  });

  it('unknown id → 404', async () => {
    expect((await call('get', '/api/games/999999')).status).toBe(404);
    expect((await call('get', '/api/games/abc')).status).toBe(404);
  });
});

describe('games visibility — age ratings (Review Focus 3)', () => {
  it('18+ game: guest and 17-year-old get exactly the restricted keys', async () => {
    const gm = await userWithAge(30, 'Elder');
    const id = await createGame(gm.cookie, { ageRating: '18+' }, true);
    const teen = await userWithAge(17);
    for (const cookie of [undefined, teen.cookie]) {
      const res = await call('get', `/api/games/${id}`, cookie);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(RESTRICTED_KEYS);
      expect(res.body).toMatchObject({ id, ageRating: '18+', restricted: true });
      expect(Object.keys(res.body.gm).sort()).toEqual(['avatarUrl', 'nickname', 'publicId']);
      expect(res.body.gm.nickname).toBe('Elder');
    }
  });

  it('18+ game: 18-year-old gets the full view without private fields', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { ageRating: '18+' }, true);
    const adult = await userWithAge(18);
    const body = (await call('get', `/api/games/${id}`, adult.cookie)).body;
    expect(body.restricted).toBeUndefined();
    expect(body.description).toBe('Готичний жах');
    expect(body.platform).toBe('Foundry');
    expect('address' in body).toBe(false);
    expect('channelLinks' in body).toBe(false);
  });

  it('21+ game is restricted for a 19-year-old, open for 21', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { ageRating: '21+' }, true);
    const nineteen = await userWithAge(19);
    const body = (await call('get', `/api/games/${id}`, nineteen.cookie)).body;
    expect(Object.keys(body).sort()).toEqual(RESTRICTED_KEYS);
    const adult = await userWithAge(21);
    expect((await call('get', `/api/games/${id}`, adult.cookie)).body.restricted).toBeUndefined();
  });
});
