import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/auth/session.service.js';
import { gameSystems } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

async function login(userId: number): Promise<string> {
  const { token } = await createSession(deps, userId, {});
  return `nri_sid=${token}; nri_csrf=t`;
}
const call = (method: 'get' | 'patch', path: string, cookie: string, body?: object) =>
  request(app)[method](path).set('Cookie', cookie).set('X-CSRF-Token', 't').send(body);

async function systemIds(n: number): Promise<number[]> {
  const rows = await db.select({ id: gameSystems.id }).from(gameSystems).limit(n);
  return rows.map((r) => r.id);
}

describe('profiles', () => {
  it('hidden city is absent in public JSON but present in own profile', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const cookie = await login(u.id);
    const patch = await call('patch', '/api/me/profile', cookie, {
      bio: 'Hi',
      city: 'Lviv',
      privacy: { city: false },
    });
    expect(patch.status).toBe(200);
    const own = await call('get', '/api/me/profile', cookie);
    expect(own.body.city).toBe('Lviv');
    expect(own.body.privacy.city).toBe(false);
    const pub = await request(app).get(`/api/users/${u.publicId}`);
    expect(pub.status).toBe(200);
    expect('city' in pub.body).toBe(false);
    expect(pub.body.bio).toBe('Hi');
    expect(pub.body.nickname).toBe('Hero');
    expect(pub.body.gamesAsGm).toEqual([]);
    expect(pub.body.gamesAsPlayer).toEqual([]);
  });

  it('favorite systems and other fields are visible by default', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const ids = await systemIds(2);
    await call('patch', '/api/me/profile', await login(u.id), {
      favoriteSystemIds: ids,
      preferredFormats: ['online'],
      experience: 'veteran',
    });
    const pub = (await request(app).get(`/api/users/${u.publicId}`)).body;
    expect(pub.favoriteSystemIds).toEqual(ids);
    expect(pub.preferredFormats).toEqual(['online']);
    expect(pub.experience).toBe('veteran');
  });

  it('hiding favoriteSystems removes the key; privacy merges across patches', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const cookie = await login(u.id);
    await call('patch', '/api/me/profile', cookie, { privacy: { favoriteSystems: false } });
    await call('patch', '/api/me/profile', cookie, { privacy: { experience: false } });
    const pub = (await request(app).get(`/api/users/${u.publicId}`)).body;
    expect('favoriteSystemIds' in pub).toBe(false);
    expect('experience' in pub).toBe(false);
    expect(pub.preferredFormats).toEqual([]);
  });

  it('deleted user exposes only publicId and status', async () => {
    const u = await createUser(db, { status: 'deleted' });
    const res = await request(app).get(`/api/users/${u.publicId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicId: u.publicId, status: 'deleted' });
  });

  it('unknown publicId is 404', async () => {
    const res = await request(app).get('/api/users/doesnotexist');
    expect(res.status).toBe(404);
  });

  it('validates input: unknown/inactive system, >10 systems, long bio', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const cookie = await login(u.id);
    const bad = async (body: object) =>
      (await call('patch', '/api/me/profile', cookie, body)).status;
    expect(await bad({ favoriteSystemIds: [999999] })).toBe(400);
    expect(await bad({ favoriteSystemIds: Array.from({ length: 11 }, (_, i) => i + 1) })).toBe(400);
    expect(await bad({ bio: 'x'.repeat(1001) })).toBe(400);
    expect(await bad({ city: 'x'.repeat(81) })).toBe(400);
    expect(await bad({ privacy: { bogus: true } })).toBe(400);
    const [id] = await systemIds(1);
    await db.update(gameSystems).set({ isActive: false }).where(eq(gameSystems.id, id!));
    try {
      expect(await bad({ favoriteSystemIds: [id!] })).toBe(400);
    } finally {
      await db.update(gameSystems).set({ isActive: true }).where(eq(gameSystems.id, id!));
    }
  });

  it('requires auth; pending users cannot PATCH', async () => {
    expect((await request(app).get('/api/me/profile')).status).toBe(401);
    const p = await createUser(db, { status: 'pending' });
    const res = await call('patch', '/api/me/profile', await login(p.id), { bio: 'x' });
    expect(res.status).toBe(403);
  });

  it('returns defaults for a user without profile row', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const res = await call('get', '/api/me/profile', await login(u.id));
    expect(res.body).toEqual({
      bio: null,
      city: null,
      favoriteSystemIds: [],
      preferredFormats: [],
      experience: null,
      privacy: {
        bio: true,
        city: true,
        favoriteSystems: true,
        preferredFormats: true,
        experience: true,
      },
    });
  });
});
