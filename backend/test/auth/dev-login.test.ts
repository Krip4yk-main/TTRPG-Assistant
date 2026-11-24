import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { isLocalRequest } from '../../src/auth/dev-login.js';
import { authIdentities, users } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const base = await testDeps();
const { db, redis } = base;

const DEV = { NODE_ENV: 'development', DEV_LOGIN_ENABLED: 'true', DEV_OWNER_KEY: 'sekret-key' };

async function appWith(extra: Record<string, string>) {
  const d = await testDeps(extra);
  d.redis.disconnect();
  return createApp({ ...d, db, redis });
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  request(app)
    .post('/api/auth/dev-login')
    .set('Cookie', 'nri_csrf=t')
    .set('X-CSRF-Token', 't')
    .send(body as object);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(base);
});

describe('isLocalRequest', () => {
  it('accepts loopback addresses', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect(isLocalRequest({ socket: { remoteAddress: a }, headers: {} } as never)).toBe(true);
  });
  it('rejects remote address even with spoofed X-Forwarded-For', () => {
    expect(
      isLocalRequest({
        socket: { remoteAddress: '10.0.0.5' },
        headers: { 'x-forwarded-for': '127.0.0.1' },
      } as never),
    ).toBe(false);
    expect(isLocalRequest({ socket: {}, headers: {} } as never)).toBe(false);
  });
});

describe('dev-login proxy hardening', () => {
  it('isLocalRequest false when any proxy header present', () => {
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'])
      expect(
        isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { [h]: 'x' } } as never),
      ).toBe(false);
  });
  it('404 when TRUST_PROXY>0', async () => {
    const res = await post(await appWith({ ...DEV, TRUST_PROXY: '1' }), { nickname: 'Hero' });
    expect(res.status).toBe(404);
  });
  it('404 for local socket with X-Forwarded-For', async () => {
    const res = await post(await appWith(DEV), { nickname: 'Hero' }).set('X-Forwarded-For', '8.8.8.8');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/dev-login', () => {
  it('logs in from localhost, creating an active dev user and cookie', async () => {
    const app = await appWith(DEV);
    const res = await post(app, { nickname: 'Hero' });
    expect(res.status).toBe(200);
    expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/nri_sid=/);
    const [u] = await db.select().from(users).where(eq(users.nickname, 'Hero'));
    expect(u).toMatchObject({ status: 'active', birthDate: '2000-01-01', role: 'user' });
    const ids = await db.select().from(authIdentities).where(eq(authIdentities.userId, u!.id));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'dev', subject: 'Hero' });
    // повторний вхід — той самий користувач
    const again = await post(app, { nickname: 'Hero' });
    expect(again.status).toBe(200);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('404 when NODE_ENV=production or DEV_LOGIN_ENABLED=false', async () => {
    for (const extra of [{ ...DEV, NODE_ENV: 'production' }, { ...DEV, DEV_LOGIN_ENABLED: 'false' }]) {
      const res = await post(await appWith(extra), { nickname: 'Hero' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('owner: no key / wrong key -> 403, right key -> 200', async () => {
    await createUser(db, { nickname: 'Boss', role: 'owner' });
    const app = await appWith(DEV);
    for (const body of [{ nickname: 'Boss' }, { nickname: 'Boss', ownerKey: 'nope' }, { nickname: 'Boss', ownerKey: 'sekret-keyX' }]) {
      const r = await post(app, body);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: 'FORBIDDEN' } });
    }
    const ok = await post(app, { nickname: 'Boss', ownerKey: 'sekret-key' });
    expect(ok.status).toBe(200);
    expect((ok.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/nri_sid=/);
  });

  it('owner login impossible when DEV_OWNER_KEY is unset', async () => {
    await createUser(db, { nickname: 'Boss', role: 'owner' });
    const app = await appWith({ NODE_ENV: 'development', DEV_LOGIN_ENABLED: 'true' });
    expect((await post(app, { nickname: 'Boss' })).status).toBe(403);
    expect((await post(app, { nickname: 'Boss', ownerKey: '' })).status).toBe(403);
  });

  it('409 NICKNAME_TAKEN for existing non-dev non-owner user', async () => {
    await createUser(db, { nickname: 'Taken' });
    const res = await post(await appWith(DEV), { nickname: 'Taken' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'NICKNAME_TAKEN' } });
  });

  it('403 ACCOUNT_BANNED for banned dev user; 400 for invalid body', async () => {
    const app = await appWith(DEV);
    await post(app, { nickname: 'Bad' });
    await db.update(users).set({ isBanned: true }).where(eq(users.nickname, 'Bad'));
    const res = await post(app, { nickname: 'Bad' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'ACCOUNT_BANNED' } });
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { nickname: 'x'.repeat(33) })).status).toBe(400);
  });
});
