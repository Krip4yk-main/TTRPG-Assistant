import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { DEV_LOGIN_CODE_ATTEMPTS } from '../../src/http/security.js';
import { authIdentities, events, sessions, users } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const base = await testDeps();
const { db, redis } = base;

// Фейкові коди лише для тестів.
const CODE_ALICE = 'beta-test-code-alice-0123456789';
const CODE_PLAIN = 'beta-test-code-plain-0123456789';
const OWNER_KEY = 'beta-owner-key-ignored';

const BETA = {
  DEPLOY_ENV: 'dev',
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://dev.nri.example.com',
  TRUST_PROXY: '1',
  DEV_LOGIN_ENABLED: 'true',
  DEV_LOGIN_CODES: `alice:${CODE_ALICE},${CODE_PLAIN}`,
  DEV_OWNER_KEY: OWNER_KEY,
};
const PROD = {
  DEPLOY_ENV: 'prod',
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://nri.example.com',
  TRUST_PROXY: '1',
};

async function appWith(extra: Record<string, string>) {
  const d = await testDeps(extra);
  d.redis.disconnect();
  return createApp({ ...d, db, redis });
}

type App = ReturnType<typeof createApp>;
let ipSeq = 0;
/** Кожен тест — власна IP (ліміти не перетікають між тестами). */
const nextIp = () => `203.0.113.${++ipSeq}`;

const postTo = (app: App, path: string, body: unknown, ip: string) =>
  request(app)
    .post(path)
    .set('X-Forwarded-For', ip)
    .set('Cookie', 'nri_csrf=t')
    .set('X-CSRF-Token', 't')
    .send(body as object);
const codeLogin = (app: App, body: unknown, ip: string) =>
  postTo(app, '/api/auth/dev-login/code', body, ip);

const devLoginEvents = () => db.select().from(events).where(eq(events.type, 'auth.dev_login'));

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(base);
});

describe('beta (DEPLOY_ENV=dev) dev login by code', () => {
  it('valid code + new nickname creates an active dev user with a session', async () => {
    const app = await appWith(BETA);
    const res = await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, nextIp());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ nickname: 'Tester', role: 'user' });
    expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/nri_sid=/);
    const [u] = await db.select().from(users).where(eq(users.nickname, 'Tester'));
    expect(u).toMatchObject({ status: 'active', role: 'user' });
    const ids = await db.select().from(authIdentities).where(eq(authIdentities.userId, u!.id));
    expect(ids).toEqual([expect.objectContaining({ provider: 'dev', subject: 'Tester' })]);
  });

  it('logs every successful login with the code label/index, never the code', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    expect((await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, ip)).status).toBe(200);
    expect((await codeLogin(app, { code: CODE_PLAIN, nickname: 'Tester' }, ip)).status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.nickname, 'Tester'));
    const rows = await devLoginEvents();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.userId, r.entityType, r.entityId])).toEqual([
      [u!.id, 'user', u!.id],
      [u!.id, 'user', u!.id],
    ]);
    expect(rows.map((r) => r.payload)).toEqual([
      { codeLabel: 'alice', codeIndex: 0, created: true },
      { codeLabel: '#2', codeIndex: 1, created: false },
    ]);
    const all = JSON.stringify(await db.select().from(events));
    expect(all).not.toContain(CODE_ALICE);
    expect(all).not.toContain(CODE_PLAIN);
  });

  it('wrong, missing, truncated or extended code -> 403 FORBIDDEN, nothing created', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    for (const body of [
      { nickname: 'Tester' },
      { code: '', nickname: 'Tester' },
      { code: 'nope', nickname: 'Tester' },
      { code: CODE_ALICE.slice(0, -1), nickname: 'Tester' },
      { code: `${CODE_ALICE}x`, nickname: 'Tester' },
      { code: `alice:${CODE_ALICE}`, nickname: 'Tester' },
      { code: 123, nickname: 'Tester' },
      { code: 'nope' },
    ]) {
      const res = await codeLogin(app, body, ip);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN' } });
      expect(res.headers['set-cookie'] ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/nri_sid=/)]),
      );
    }
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await devLoginEvents()).toHaveLength(0);
  });

  it('valid code with invalid nickname -> 400', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    for (const nickname of [
      'x'.repeat(33),
      'Te ster',
      `Tester${String.fromCharCode(0x200b)}`,
      'ab',
    ]) {
      const res = await codeLogin(app, { code: CODE_ALICE, nickname }, ip);
      expect(res.status).toBe(400);
    }
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('audit write failure -> no session (event is written before the cookie)', async () => {
    const ok = await appWith(BETA);
    expect((await codeLogin(ok, { code: CODE_ALICE, nickname: 'Tester' }, nextIp())).status).toBe(
      200,
    );
    await db.delete(sessions);
    const d = await testDeps(BETA);
    d.redis.disconnect();
    // БД, у якій запис у журнал подій падає (інші таблиці — як є).
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'insert') {
          return (table: unknown) =>
            table === events
              ? { values: () => Promise.reject(new Error('audit down')) }
              : target.insert(table as typeof users);
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const app = createApp({ ...d, db: brokenDb, redis });
    const res = await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, nextIp());
    expect(res.status).toBe(500);
    expect((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/nri_sid=/)]),
    );
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('staff cannot log in with a tester code (owner key is ignored on beta)', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    // Персонал без dev-ідентичності (справжні акаунти): нікнейм зайнятий.
    for (const role of ['owner', 'admin', 'moderator'] as const) {
      await createUser(db, { nickname: `Staff_${role}`, role });
      const res = await codeLogin(
        app,
        { code: CODE_ALICE, nickname: `Staff_${role}`, ownerKey: OWNER_KEY },
        ip,
      );
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'NICKNAME_TAKEN' } });
    }
    // Dev-акаунт, якому видали роль персоналу: вхід за кодом заборонено.
    expect((await codeLogin(app, { code: CODE_ALICE, nickname: 'Promo' }, ip)).status).toBe(200);
    for (const role of ['owner', 'admin', 'moderator'] as const) {
      await db.update(users).set({ role }).where(eq(users.nickname, 'Promo'));
      const res = await codeLogin(
        app,
        { code: CODE_ALICE, nickname: 'Promo', ownerKey: OWNER_KEY },
        ip,
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN' } });
    }
    expect(await devLoginEvents()).toHaveLength(1);
  });

  it('banned dev user -> 403 ACCOUNT_BANNED', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    await codeLogin(app, { code: CODE_ALICE, nickname: 'Bad' }, ip);
    await db.update(users).set({ isBanned: true }).where(eq(users.nickname, 'Bad'));
    const res = await codeLogin(app, { code: CODE_ALICE, nickname: 'Bad' }, ip);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BANNED');
  });

  it('limits failed attempts per IP -> 429; other IPs and successes unaffected', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    for (let i = 0; i < DEV_LOGIN_CODE_ATTEMPTS; i++) {
      expect((await codeLogin(app, { code: `guess-${i}`, nickname: 'T' }, ip)).status).toBe(403);
    }
    const limited = await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED' } });
    // Інша IP — свій лічильник.
    const other = nextIp();
    expect((await codeLogin(app, { code: 'nope', nickname: 'T' }, other)).status).toBe(403);
    // Успішні входи ліміт не витрачають.
    for (let i = 0; i < DEV_LOGIN_CODE_ATTEMPTS + 2; i++) {
      expect((await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, other)).status).toBe(
        200,
      );
    }
  });

  it('local form route is not mounted on beta (404), even with owner key', async () => {
    await createUser(db, { nickname: 'Boss', role: 'owner' });
    const app = await appWith(BETA);
    for (const body of [{ nickname: 'Hero' }, { nickname: 'Boss', ownerKey: OWNER_KEY }]) {
      const res = await postTo(app, '/api/auth/dev-login', body, nextIp());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('DEV_LOGIN_ENABLED=false on beta -> code route 404', async () => {
    const app = await appWith({ ...BETA, DEV_LOGIN_ENABLED: 'false' });
    const res = await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, nextIp());
    expect(res.status).toBe(404);
  });
});

describe('dev login status probe', () => {
  const STATUS = '/api/auth/dev-login/code/status';
  const probe = (app: App, ip: string) => request(app).get(STATUS).set('X-Forwarded-For', ip);

  it('beta enabled: 204 without a body, no session needed', async () => {
    const res = await probe(await appWith(BETA), nextIp());
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('does not count against the failed-code limiter', async () => {
    const app = await appWith(BETA);
    const ip = nextIp();
    for (let i = 0; i < DEV_LOGIN_CODE_ATTEMPTS + 2; i++) {
      expect((await probe(app, ip)).status).toBe(204);
    }
    const ok = await codeLogin(app, { code: CODE_ALICE, nickname: 'Tester' }, ip);
    expect(ok.status).toBe(200);
  });

  it('DEV_LOGIN_ENABLED=false on beta -> 404', async () => {
    const res = await probe(await appWith({ ...BETA, DEV_LOGIN_ENABLED: 'false' }), nextIp());
    expect(res.status).toBe(404);
  });

  it('prod and local: 404', async () => {
    expect((await probe(await appWith(PROD), nextIp())).status).toBe(404);
    const local = await appWith({
      NODE_ENV: 'development',
      DEV_LOGIN_ENABLED: 'true',
      DEV_LOGIN_CODES: `alice:${CODE_ALICE}`,
    });
    expect((await probe(local, nextIp())).status).toBe(404);
  });
});

describe('dev login off outside beta', () => {
  it('prod: both routes 404', async () => {
    const app = await appWith(PROD);
    for (const path of ['/api/auth/dev-login', '/api/auth/dev-login/code']) {
      const res = await postTo(app, path, { code: CODE_ALICE, nickname: 'Hero' }, nextIp());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('local: code route is not mounted (404), the form route still works', async () => {
    const app = await appWith({
      NODE_ENV: 'development',
      DEV_LOGIN_ENABLED: 'true',
      DEV_LOGIN_CODES: `alice:${CODE_ALICE}`,
    });
    const local = (path: string, body: object) =>
      request(app).post(path).set('Cookie', 'nri_csrf=t').set('X-CSRF-Token', 't').send(body);
    const res = await local('/api/auth/dev-login/code', { code: CODE_ALICE, nickname: 'Hero' });
    expect(res.status).toBe(404);
    expect((await local('/api/auth/dev-login', { nickname: 'Hero' })).status).toBe(200);
    expect(await devLoginEvents()).toHaveLength(0);
  });
});
