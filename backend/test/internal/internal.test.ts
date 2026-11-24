import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/auth/session.service.js';
import { authIdentities, users } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps({ TELEGRAM_BOT_USERNAME: 'nri_test_bot' });
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

async function issueToken(userId: number): Promise<string> {
  const { token } = await createSession(deps, userId, {});
  const res = await request(app)
    .post('/api/me/telegram-link-token')
    .set('Cookie', `nri_sid=${token}; nri_csrf=t`)
    .set('X-CSRF-Token', 't');
  expect(res.status).toBe(200);
  const m = /^https:\/\/t\.me\/nri_test_bot\?start=([A-Za-z0-9_-]{22})$/.exec(res.body.url);
  expect(m).not.toBeNull();
  return m![1]!;
}

const link = (body: object, key: string | null = 'test-internal-key-0123456789abcdefghij') => {
  const r = request(app).post('/api/internal/telegram/link');
  if (key !== null) r.set('X-Internal-Key', key);
  return r.send(body);
};

describe('POST /api/me/telegram-link-token', () => {
  it('requires an active session', async () => {
    const res = await request(app)
      .post('/api/me/telegram-link-token')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't');
    expect(res.status).toBe(401);
  });

  it('stores a 10-minute token in redis', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const token = await issueToken(u.id);
    expect(await redis.get(`tglink:${token}`)).toBe(String(u.id));
    const ttl = await redis.ttl(`tglink:${token}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('404 when bot username is not configured', async () => {
    const d = await testDeps();
    try {
      const a = createApp(d);
      const u = await createUser(d.db, { nickname: 'H2' });
      const { token } = await createSession(d, u.id, {});
      const res = await request(a)
        .post('/api/me/telegram-link-token')
        .set('Cookie', `nri_sid=${token}; nri_csrf=t`)
        .set('X-CSRF-Token', 't');
      expect(res.status).toBe(404);
    } finally {
      await closeDeps(d);
    }
  });
});

describe('POST /api/internal/telegram/link', () => {
  const body = (token: string) => ({ token, telegramId: 777, displayName: 'tg_hero' });

  it('rejects missing or wrong key with 401', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const token = await issueToken(u.id);
    expect((await link(body(token), null)).status).toBe(401);
    const wrong = await link(body(token), 'nope');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
    expect((await link(body(token), 'test-internal-key-0123456789abcdefghijx')).status).toBe(401);
    expect(await redis.get(`tglink:${token}`)).not.toBeNull();
  });

  it('links the identity and the token is one-time', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const token = await issueToken(u.id);
    const res = await link(body(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, nickname: 'Hero' });
    const rows = await db.select().from(authIdentities).where(eq(authIdentities.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'telegram', subject: '777', displayName: 'tg_hero' });
    const again = await link(body(token));
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('NOT_FOUND');
  });

  it('deleted account: token is useless, no identity row', async () => {
    const u = await createUser(db, { nickname: 'Gone' });
    const token = await issueToken(u.id);
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, u.id));
    const res = await link(body(token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(
      await db.select().from(authIdentities).where(eq(authIdentities.userId, u.id)),
    ).toHaveLength(0);
  });

  it('banned account cannot link', async () => {
    const u = await createUser(db, { nickname: 'Bad' });
    const token = await issueToken(u.id);
    await db.update(users).set({ isBanned: true }).where(eq(users.id, u.id));
    const res = await link(body(token));
    expect(res.status).toBe(404);
  });

  it('unknown token is 404; invalid body is 400', async () => {
    expect((await link(body('nonexistent'))).status).toBe(404);
    expect((await link({ token: 1 })).status).toBe(400);
  });

  it('IDENTITY_TAKEN when telegram belongs to another user', async () => {
    const a = await createUser(db, { nickname: 'A' });
    const b = await createUser(db, { nickname: 'B' });
    expect((await link(body(await issueToken(a.id)))).status).toBe(200);
    const res = await link(body(await issueToken(b.id)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDENTITY_TAKEN');
  });

  it('PROVIDER_ALREADY_LINKED for a second telegram account', async () => {
    const a = await createUser(db, { nickname: 'A' });
    expect((await link(body(await issueToken(a.id)))).status).toBe(200);
    const res = await link({ ...body(await issueToken(a.id)), telegramId: '888' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROVIDER_ALREADY_LINKED');
  });
});
