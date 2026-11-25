import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { events, sanctionAppeals, sanctions, users } from '../../src/db/schema/index.js';
import { decideAppeal } from '../../src/moderation/appeals.service.js';
import { imposeSanction, liftSanction } from '../../src/moderation/sanctions.service.js';
import { createSession } from '../../src/auth/session.service.js';
import { banUser } from '../../src/users/users.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const base = await testDeps();
const { db, redis } = base;

const DEV = { NODE_ENV: 'development', DEV_LOGIN_ENABLED: 'true' };

async function appWith(extra: Record<string, string> = {}) {
  const d = await testDeps({ ...DEV, ...extra });
  d.redis.disconnect();
  return createApp({ ...d, db, redis });
}

const app = await appWith();

const csrfPost = (a: ReturnType<typeof createApp>, path: string, body: unknown) =>
  request(a)
    .post(path)
    .set('Cookie', 'nri_csrf=t')
    .set('X-CSRF-Token', 't')
    .send(body as object);

const devLogin = (nickname: string) => csrfPost(app, '/api/auth/dev-login', { nickname });
const appeal = (appealToken: string, message: string, a = app) =>
  csrfPost(a, '/api/appeals', { appealToken, message });

/** Створює dev-користувача й банить його через banUser. */
async function bannedUser(nickname = 'Bad') {
  expect((await devLogin(nickname)).status).toBe(200);
  const [u] = await db.select().from(users).where(eq(users.nickname, nickname));
  await banUser(base, u!.id);
  return u!;
}

async function bannedLoginToken(nickname = 'Bad'): Promise<string> {
  const res = await devLogin(nickname);
  expect(res.status).toBe(403);
  return res.body.error.details.appealToken as string;
}

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(base);
});

describe('banned login', () => {
  it('dev-login of a banned user → 403 with a limited appeal token, no session', async () => {
    const u = await bannedUser();
    const res = await devLogin('Bad');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BANNED');
    const { appealToken, appealSent } = res.body.error.details;
    expect(appealSent).toBe(false);
    expect(appealToken).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/nri_sid=/);
    expect(await redis.get(`appeal:${appealToken}`)).toBe(String(u.id));
    const ttl = await redis.ttl(`appeal:${appealToken}`);
    expect(ttl).toBeGreaterThan(1700);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  it('appeal token grants no other access', async () => {
    await bannedUser();
    const token = await bannedLoginToken();
    for (const cookie of [`nri_sid=${token}`, `appeal=${token}`]) {
      const me = await request(app).get('/api/me').set('Cookie', cookie);
      expect(me.status).toBe(401);
    }
    const me = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(401);
  });

  it('existing session of a banned user → 403 with appeal token', async () => {
    const u = await createUser(db, { nickname: 'Mid' });
    const { token } = await createSession(base, u.id, {});
    await banUser(base, u.id);
    const res = await request(app).get('/api/me').set('Cookie', `nri_sid=${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_BANNED');
    const { appealToken, appealSent } = res.body.error.details;
    expect(appealSent).toBe(false);
    expect(await redis.get(`appeal:${appealToken}`)).toBe(String(u.id));
    // сесію відкликано
    expect((await request(app).get('/api/me').set('Cookie', `nri_sid=${token}`)).status).toBe(401);
  });
});

describe('POST /api/appeals', () => {
  it('flag-only ban: one appeal on a system ban sanction, logs appeal.created', async () => {
    const u = await bannedUser();
    const token = await bannedLoginToken();
    const res = await appeal(token, '  Це помилка, прошу розбанити  ');
    expect(res.status).toBe(201);
    const [s] = await db.select().from(sanctions);
    expect(s).toMatchObject({ userId: u.id, type: 'global_ban', imposedBy: null, endsAt: null });
    const rows = await db.select().from(sanctionAppeals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: u.id,
      sanctionId: s!.id,
      status: 'pending',
      message: 'Це помилка, прошу розбанити',
    });
    expect(res.body).toEqual({ id: rows[0]!.id });
    const ev = await db.select().from(events).where(eq(events.type, 'appeal.created'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      userId: u.id,
      entityType: 'sanction_appeal',
      entityId: rows[0]!.id,
    });

    // токен одноразовий
    expect((await appeal(token, 'ще раз')).status).toBe(401);
    // новий вхід — appealSent=true, статус апеляції; друга апеляція → 409
    const again = await devLogin('Bad');
    expect(again.body.error.details).toMatchObject({ appealSent: true, appealStatus: 'pending' });
    const dup = await appeal(again.body.error.details.appealToken as string, 'друга');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('APPEAL_EXISTS');
    expect(await db.select().from(sanctionAppeals)).toHaveLength(1);
    expect(await db.select().from(sanctions)).toHaveLength(1);
  });

  it('appeals the active global_ban sanction; banned screen shows the decision status', async () => {
    const admin = await createUser(db, { nickname: 'Admin', role: 'admin' });
    expect((await devLogin('Bad')).status).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.nickname, 'Bad'));
    const ban = await imposeSanction(base, admin.id, u!.id, {
      type: 'global_ban',
      duration: '30d',
      reason: 'Шахрайство',
    });
    const first = await devLogin('Bad');
    expect(first.body.error.details).toMatchObject({ appealSent: false, appealStatus: null });
    expect((await appeal(first.body.error.details.appealToken as string, 'прошу')).status).toBe(
      201,
    );
    const [a] = await db.select().from(sanctionAppeals);
    expect(a).toMatchObject({ sanctionId: ban.id, status: 'pending' });
    await decideAppeal(base, admin.id, a!.id, { accept: false, note: 'Ні' });
    const after = await devLogin('Bad');
    expect(after.body.error.details).toMatchObject({ appealSent: true, appealStatus: 'rejected' });
  });

  it('token is burned by final answers (201/409/403) but survives an unexpected error', async () => {
    const u = await bannedUser();
    const token = await bannedLoginToken();
    const tx = vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const failed = await appeal(token, 'перша спроба');
    tx.mockRestore();
    expect(failed.status).toBe(500);
    expect(await redis.get(`appeal:${token}`)).toBe(String(u.id));
    expect((await appeal(token, 'повтор')).status).toBe(201);
    expect(await redis.get(`appeal:${token}`)).toBeNull();

    const dupToken = await bannedLoginToken();
    expect((await appeal(dupToken, 'друга')).status).toBe(409);
    expect(await redis.get(`appeal:${dupToken}`)).toBeNull();

    const unbanToken = await bannedLoginToken();
    await db.update(users).set({ isBanned: false }).where(eq(users.id, u.id));
    expect((await appeal(unbanToken, 'ще')).status).toBe(403);
    expect(await redis.get(`appeal:${unbanToken}`)).toBeNull();
  });

  it('after a lift and a new ban the user can appeal again', async () => {
    const admin = await createUser(db, { nickname: 'Admin', role: 'admin' });
    const u = await bannedUser();
    expect((await appeal(await bannedLoginToken(), 'перша')).status).toBe(201);
    const [first] = await db.select().from(sanctions);
    await liftSanction(base, admin.id, first!.id);
    await imposeSanction(base, admin.id, u.id, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Знову',
    });
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id));
    expect(fresh!.banEpoch).toBe(2);
    const res = await devLogin('Bad');
    expect(res.body.error.details.appealSent).toBe(false);
    expect((await appeal(res.body.error.details.appealToken as string, 'друга')).status).toBe(201);
    const rows = await db.select().from(sanctionAppeals).orderBy(sanctionAppeals.id);
    expect(rows.map((r) => r.message)).toEqual(['перша', 'друга']);
    expect(new Set(rows.map((r) => r.sanctionId)).size).toBe(2);
  });

  it('banUser on an already banned user does not open a new ban period', async () => {
    const u = await bannedUser();
    await banUser(base, u.id);
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id));
    expect(fresh!.banEpoch).toBe(1);
  });

  it('rejects invalid token and invalid messages', async () => {
    await bannedUser();
    expect((await appeal('nope-not-a-token', 'привіт')).status).toBe(401);
    const token = await bannedLoginToken();
    for (const msg of ['', '   ', 'x'.repeat(2001)]) {
      const r = await appeal(token, msg);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION');
    }
    // невалідне тіло не спалює токен
    expect((await appeal(token, 'x'.repeat(2000))).status).toBe(201);
  });

  it('refuses an appeal once the user is no longer banned', async () => {
    const u = await bannedUser();
    const token = await bannedLoginToken();
    await db.update(users).set({ isBanned: false }).where(eq(users.id, u.id));
    const r = await appeal(token, 'вже не треба');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    expect(await db.select().from(sanctionAppeals)).toHaveLength(0);
  });

  it('is rate limited like auth routes', async () => {
    const limited = await appWith({ RATE_LIMIT_AUTH_MAX: '2' });
    expect((await appeal('a', 'm', limited)).status).toBe(401);
    expect((await appeal('b', 'm', limited)).status).toBe(401);
    const r = await appeal('c', 'm', limited);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });
});
