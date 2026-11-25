import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  events,
  identityTombstones,
  sessions,
  users,
} from '../../src/db/schema/index.js';
import { linkIdentity, resolveLogin, subjectHash } from '../../src/auth/identity.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { sign, TEST_BOT_TOKEN as TOKEN } from './telegram-sign.js';

const deps = await testDeps({ TELEGRAM_BOT_TOKEN: TOKEN });
const { db, redis, env } = deps;

beforeEach(async () => {
  await resetDb(db);
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const ident = (subject: string, avatarUrl?: string) =>
  ({ provider: 'telegram', subject, displayName: 'Ada', avatarUrl }) as const;

const banTombstone = (subject: string) =>
  db.insert(identityTombstones).values({
    provider: 'telegram',
    subjectHash: subjectHash('telegram', subject, env.IDENTITY_PEPPER),
    isBanned: true,
  });

describe('subjectHash', () => {
  it('is deterministic 64-hex and depends on pepper/provider/subject', () => {
    const h = subjectHash('telegram', '1', 'p');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(subjectHash('telegram', '1', 'p')).toBe(h);
    expect(subjectHash('telegram', '1', 'q')).not.toBe(h);
    expect(subjectHash('google', '1', 'p')).not.toBe(h);
  });
});

describe('resolveLogin', () => {
  it('first login creates pending user, second returns same user', async () => {
    const a = await resolveLogin(deps, ident('100', 'https://x/a.jpg'));
    expect(a.isNew).toBe(true);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(u).toMatchObject({ status: 'pending', avatarUrl: 'https://x/a.jpg' });
    const b = await resolveLogin(deps, ident('100'));
    expect(b).toEqual({ userId: a.userId, isNew: false });
    const ev = await db.select().from(events).where(eq(events.type, 'user.registered'));
    expect(ev).toHaveLength(1);
  });

  it('concurrent first logins yield one user', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => resolveLogin(deps, ident('200'))));
    expect(new Set(rs.map((r) => r.userId)).size).toBe(1);
    expect(rs.filter((r) => r.isNew)).toHaveLength(1);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('banned tombstone blocks registration', async () => {
    await banTombstone('300');
    await expect(resolveLogin(deps, ident('300'))).rejects.toMatchObject({
      status: 403,
      code: 'IDENTITY_BANNED',
    });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('non-banned tombstone does not block', async () => {
    await db.insert(identityTombstones).values({
      provider: 'telegram',
      subjectHash: subjectHash('telegram', '301', env.IDENTITY_PEPPER),
      isBanned: false,
    });
    expect((await resolveLogin(deps, ident('301'))).isNew).toBe(true);
  });
});

describe('linkIdentity', () => {
  it('links, is idempotent for own identity, 409 for foreign', async () => {
    const u1 = await createUser(db);
    const u2 = await createUser(db);
    await linkIdentity(deps, u1.id, ident('400'));
    await linkIdentity(deps, u1.id, ident('400'));
    const rows = await db.select().from(authIdentities).where(eq(authIdentities.userId, u1.id));
    expect(rows).toHaveLength(1);
    await expect(linkIdentity(deps, u2.id, ident('400'))).rejects.toMatchObject({
      status: 409,
      code: 'IDENTITY_TAKEN',
    });
  });

  it('banned tombstone blocks linking', async () => {
    const u = await createUser(db);
    await banTombstone('500');
    await expect(linkIdentity(deps, u.id, ident('500'))).rejects.toMatchObject({
      status: 403,
      code: 'IDENTITY_BANNED',
    });
  });
});

describe('telegram routes', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const widget = (id = '777') => sign({ id, first_name: 'Ada', auth_date: String(now()) }, TOKEN);
  const cookies = (res: request.Response) =>
    ((res.headers['set-cookie'] ?? []) as unknown as string[]).join(';');

  async function agentWithCsrf(app: ReturnType<typeof createApp>) {
    const agent = request.agent(app);
    const r = await agent.get('/api/health');
    const csrf = /nri_csrf=([^;]+)/.exec(cookies(r))![1]!;
    return { agent, csrf };
  }

  it('POST /api/auth/telegram sets nri_sid and returns user', async () => {
    const { agent, csrf } = await agentWithCsrf(createApp(deps));
    const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(widget());
    expect(res.status).toBe(200);
    expect(cookies(res)).toMatch(/nri_sid=/);
    expect(res.body.user).toMatchObject({ status: 'pending', nickname: null, avatarUrl: null });
  });

  it('rejects bad signature with 401 and no cookie', async () => {
    const { agent, csrf } = await agentWithCsrf(createApp(deps));
    const res = await agent
      .post('/api/auth/telegram')
      .set('x-csrf-token', csrf)
      .send({ ...widget(), first_name: 'Eve' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TELEGRAM_AUTH_INVALID');
    expect(cookies(res)).not.toMatch(/nri_sid/);
  });

  it('rejects invalid body shape with 400', async () => {
    const { agent, csrf } = await agentWithCsrf(createApp(deps));
    const res = await agent
      .post('/api/auth/telegram')
      .set('x-csrf-token', csrf)
      .send({ id: [1] });
    expect(res.status).toBe(400);
  });

  it('banned existing user gets 403 ACCOUNT_BANNED and no session', async () => {
    const app = createApp(deps);
    const first = await agentWithCsrf(app);
    await first.agent
      .post('/api/auth/telegram')
      .set('x-csrf-token', first.csrf)
      .send(widget('888'));
    await db.update(users).set({ isBanned: true });
    await db.delete(sessions);
    const { agent, csrf } = await agentWithCsrf(app);
    const res = await agent
      .post('/api/auth/telegram')
      .set('x-csrf-token', csrf)
      .send(widget('888'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BANNED');
    expect(res.body.error.details).toEqual({
      appealToken: expect.any(String),
      appealSent: false,
      appealStatus: null,
    });
    expect(cookies(res)).not.toMatch(/nri_sid/);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('returns 404 when bot token is not configured', async () => {
    const d2 = await testDeps();
    try {
      const { agent, csrf } = await agentWithCsrf(createApp(d2));
      const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(widget());
      expect(res.status).toBe(404);
    } finally {
      await closeDeps(d2);
    }
  });

  it('link requires auth, then links to current user; 409 if taken', async () => {
    const app = createApp(deps);
    const anon = await agentWithCsrf(app);
    const r0 = await anon.agent
      .post('/api/auth/telegram/link')
      .set('x-csrf-token', anon.csrf)
      .send(widget('901'));
    expect(r0.status).toBe(401);

    const a = await agentWithCsrf(app);
    await a.agent.post('/api/auth/telegram').set('x-csrf-token', a.csrf).send(widget('902'));
    const r1 = await a.agent
      .post('/api/auth/telegram/link')
      .set('x-csrf-token', a.csrf)
      .send(widget('903'));
    // Один провайдер — одна ідентичність на користувача.
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('PROVIDER_ALREADY_LINKED');

    const b = await agentWithCsrf(app);
    await b.agent.post('/api/auth/telegram').set('x-csrf-token', b.csrf).send(widget('904'));
    const r2 = await b.agent
      .post('/api/auth/telegram/link')
      .set('x-csrf-token', b.csrf)
      .send(widget('902'));
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('IDENTITY_TAKEN');
  });

  it('accepts extra signed fields (e.g. language_code)', async () => {
    const { agent, csrf } = await agentWithCsrf(createApp(deps));
    const body = sign(
      { id: '910', first_name: 'Ada', auth_date: String(now()), language_code: 'uk' },
      TOKEN,
    );
    const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(body);
    expect(res.status).toBe(200);
  });

  it('login with an existing session revokes the old session', async () => {
    const app = createApp(deps);
    const { agent, csrf } = await agentWithCsrf(app);
    const r1 = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(widget('920'));
    const old = /nri_sid=([^;]+)/.exec(cookies(r1))![1]!;
    const r2 = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(widget('921'));
    expect(r2.status).toBe(200);
    const stale = await request(app).get('/api/test/protected').set('Cookie', `nri_sid=${old}`);
    expect(stale.status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it('telegram/link returns 404 (not 401) when not configured', async () => {
    const d2 = await testDeps();
    try {
      const { agent, csrf } = await agentWithCsrf(createApp(d2));
      const res = await agent
        .post('/api/auth/telegram/link')
        .set('x-csrf-token', csrf)
        .send(widget());
      expect(res.status).toBe(404);
    } finally {
      await closeDeps(d2);
    }
  });
});
