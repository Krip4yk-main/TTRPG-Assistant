import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { sessions } from '../../src/db/schema/index.js';
import { createSession, resolveSession } from '../../src/auth/session.service.js';
import { banUser } from '../../src/users/users.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);

beforeEach(async () => {
  await resetDb(db);
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const get = (token: string, path = '/api/test/protected') =>
  request(app).get(path).set('Cookie', `nri_sid=${token}`);

describe('sessions', () => {
  it('stores only the sha256 hash of the token', async () => {
    const u = await createUser(db);
    const { token } = await createSession(deps, u.id, { userAgent: 'ua', ip: '1.2.3.4' });
    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await redis.keys('*')).join()).not.toContain(token);
  });

  it('requireAuth: cookie -> 200, none -> 401', async () => {
    const u = await createUser(db);
    const { token } = await createSession(deps, u.id, {});
    await get(token).expect(200);
    const res = await request(app).get('/api/test/protected').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('ban takes effect on next request even with warm cache', async () => {
    const u = await createUser(db);
    const { token } = await createSession(deps, u.id, {});
    await get(token).expect(200); // кеш прогрітий
    await banUser(deps, u.id);
    const r1 = await get(token).expect(403);
    expect(r1.body.error.code).toBe('ACCOUNT_BANNED');
    const r2 = await get(token).expect(401);
    expect(r2.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('expired session -> 401', async () => {
    const u = await createUser(db);
    const { token } = await createSession(deps, u.id, {});
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    await redis.flushdb();
    await get(token).expect(401);
    expect(await resolveSession(deps, token)).toBeNull();
  });

  it('pending user -> 403 PROFILE_INCOMPLETE on requireActive', async () => {
    const u = await createUser(db, { status: 'pending' });
    const { token } = await createSession(deps, u.id, {});
    const res = await get(token, '/api/test/active').expect(403);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
  });

  it('slides expiry at most once per 10 min and refreshes cookie', async () => {
    const u = await createUser(db);
    const { token } = await createSession(deps, u.id, {});
    const old = new Date(Math.floor((Date.now() + 3600_000) / 1000) * 1000);
    await db.update(sessions).set({ expiresAt: old });
    await get(token).expect(200);
    let [row] = await db.select().from(sessions);
    expect(row!.expiresAt.getTime()).toBe(old.getTime());
    await redis.del(`slide:${sha(token)}`);
    const res = await get(token).expect(200);
    [row] = await db.select().from(sessions);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(old.getTime());
    expect((res.headers['set-cookie'] as unknown as string[]).join()).toMatch(/nri_sid=/);
  });

  it('logout revokes only this session; logout-all revokes all', async () => {
    const u = await createUser(db);
    const a = await createSession(deps, u.id, {});
    const b = await createSession(deps, u.id, {});
    const c = await createSession(deps, u.id, {});
    for (const s of [a, b, c]) await get(s.token).expect(200);
    const csrf = 'c'.repeat(10);
    const post = (path: string, t: string) =>
      request(app)
        .post(path)
        .set('Cookie', `nri_sid=${t}; nri_csrf=${csrf}`)
        .set('X-CSRF-Token', csrf);
    await post('/api/auth/logout', a.token).expect(204);
    await get(a.token).expect(401);
    await get(b.token).expect(200);
    await post('/api/auth/logout-all', b.token).expect(204);
    await get(b.token).expect(401);
    await get(c.token).expect(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    expect(await redis.keys('sess:*')).toHaveLength(0);
    expect(await redis.exists(`usess:${u.id}`)).toBe(0);
  });
});
