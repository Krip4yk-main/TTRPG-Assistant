import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { authIdentities, events, moderationLog, users } from '../../src/db/schema/index.js';
import { bootstrapOwner, resetOwnerBootstrapWarning } from '../../src/auth/owner-bootstrap.js';
import { createSession } from '../../src/auth/session.service.js';
import { seedOwner } from '../../src/cli/seed-owner.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { sign, TEST_BOT_TOKEN as TOKEN } from './telegram-sign.js';

const OWNER_TG = '5550001';
const deps = await testDeps({ TELEGRAM_BOT_TOKEN: TOKEN, OWNER_TELEGRAM_ID: OWNER_TG });
const { db, redis } = deps;
const app = createApp(deps);
const INTERNAL_KEY = 'test-internal-key-0123456789abcdefghij';

beforeEach(async () => {
  await resetDb(db);
  await redis.flushdb();
  resetOwnerBootstrapWarning();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const now = () => Math.floor(Date.now() / 1000);
const widget = (id: string) => sign({ id, first_name: 'Ada', auth_date: String(now()) }, TOKEN);
const cookies = (res: request.Response) =>
  ((res.headers['set-cookie'] ?? []) as unknown as string[]).join(';');

async function agentWithCsrf(a = app) {
  const agent = request.agent(a);
  const r = await agent.get('/api/auth/ping');
  const csrf = /nri_csrf=([^;]+)/.exec(cookies(r))![1]!;
  return { agent, csrf };
}
const tgLogin = async (id: string, a = app) => {
  const { agent, csrf } = await agentWithCsrf(a);
  const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(widget(id));
  return { agent, csrf, res };
};
const roleOfTg = async (subject: string) => {
  const [row] = await db
    .select({ role: users.role, id: users.id })
    .from(users)
    .innerJoin(authIdentities, eq(authIdentities.userId, users.id))
    .where(eq(authIdentities.subject, subject));
  return row;
};
const owners = () => db.select({ id: users.id }).from(users).where(eq(users.role, 'owner'));

describe('OWNER_TELEGRAM_ID bootstrap — Telegram login', () => {
  it('first verified login with the owner id and no owner → owner, logged once', async () => {
    const { res } = await tgLogin(OWNER_TG);
    expect(res.status).toBe(200);
    // Сесія відкривається вже з роллю власника.
    expect(res.body.user.role).toBe('owner');
    const me = await roleOfTg(OWNER_TG);
    expect(me!.role).toBe('owner');
    expect(await db.select().from(moderationLog)).toEqual([
      expect.objectContaining({
        actorId: null,
        action: 'owner.bootstrap',
        targetType: 'user',
        targetId: me!.id,
        meta: { from: 'user', via: 'login' },
      }),
    ]);
    // Повторний вхід — без змін і без нових записів.
    expect((await tgLogin(OWNER_TG)).res.status).toBe(200);
    expect(await db.select().from(moderationLog)).toHaveLength(1);
    const ev = await db.select().from(events).where(eq(events.type, 'user.owner_bootstrapped'));
    expect(ev).toEqual([expect.objectContaining({ userId: me!.id, payload: { via: 'login' } })]);
  });

  it('another Telegram id stays a regular user', async () => {
    await tgLogin('5550002');
    expect((await roleOfTg('5550002'))!.role).toBe('user');
    expect(await owners()).toEqual([]);
  });

  it('an owner already exists (someone else) → nothing changes, warning once per process', async () => {
    await createUser(db, { role: 'owner', nickname: 'Boss' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tgLogin(OWNER_TG);
    await tgLogin(OWNER_TG);
    expect((await roleOfTg(OWNER_TG))!.role).toBe('user');
    expect(await owners()).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[owner-bootstrap]'))).toHaveLength(
      1,
    );
    // Значення id у лог не потрапляє.
    expect(warn.mock.calls.flat().join(' ')).not.toContain(OWNER_TG);
    expect(await db.select().from(moderationLog)).toEqual([]);
  });

  it('a deleted former owner does not count as an owner', async () => {
    await createUser(db, { role: 'owner', status: 'deleted' });
    await tgLogin(OWNER_TG);
    expect((await roleOfTg(OWNER_TG))!.role).toBe('owner');
  });

  it('spoofing: unsigned/tampered widget data with the owner id → 401, no owner', async () => {
    const { agent, csrf } = await agentWithCsrf();
    const forged = { ...widget('5550002'), id: OWNER_TG };
    const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(forged);
    expect(res.status).toBe(401);
    expect(await owners()).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
  });

  it('without OWNER_TELEGRAM_ID behaviour is unchanged', async () => {
    const d2 = await testDeps({ TELEGRAM_BOT_TOKEN: TOKEN });
    try {
      const { res } = await tgLogin(OWNER_TG, createApp(d2));
      expect(res.status).toBe(200);
      expect((await roleOfTg(OWNER_TG))!.role).toBe('user');
    } finally {
      await closeDeps(d2);
    }
  });
});

describe('OWNER_TELEGRAM_ID bootstrap — linking Telegram', () => {
  it('verified widget link with the owner id → owner (via link)', async () => {
    // Акаунт, що входить не через Telegram, прив'язує Telegram власника.
    const u = await createUser(db, { nickname: 'Linker' });
    await db.insert(authIdentities).values({ userId: u.id, provider: 'google', subject: 'g1' });
    const { token } = await createSession(deps, u.id, {});
    const linked = await request(app)
      .post('/api/auth/telegram/link')
      .set('Cookie', `nri_sid=${token}; nri_csrf=t`)
      .set('x-csrf-token', 't')
      .send(widget(OWNER_TG));
    expect(linked.status).toBe(200);
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, u.id));
    expect(row!.role).toBe('owner');
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({ action: 'owner.bootstrap', targetId: u.id, meta: { via: 'link' } });
  });

  it('bot link (internal API, no widget signature) never bootstraps the owner', async () => {
    const u = await createUser(db, { nickname: 'BotLinked' });
    await redis.set('tglink:tok-1', String(u.id));
    const res = await request(app)
      .post('/api/internal/telegram/link')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ token: 'tok-1', telegramId: Number(OWNER_TG), displayName: 'x' });
    expect(res.status).toBe(200);
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, u.id));
    expect(row!.role).toBe('user');
    expect(await owners()).toEqual([]);
  });
});

describe('bootstrapOwner — guards and races', () => {
  const tg = { provider: 'telegram', subject: OWNER_TG } as const;
  async function linkedUser(over: Partial<typeof users.$inferInsert> = {}) {
    const u = await createUser(db, over);
    await db
      .insert(authIdentities)
      .values({ userId: u.id, provider: 'telegram', subject: OWNER_TG });
    return u;
  }

  it('concurrent bootstraps promote exactly once', async () => {
    const u = await linkedUser();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => bootstrapOwner(deps, u.id, tg, 'login')),
    );
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(await owners()).toEqual([{ id: u.id }]);
    expect(await db.select().from(moderationLog)).toHaveLength(1);
  });

  it('racing with seed:owner for another user never yields two owners', async () => {
    const u = await linkedUser();
    await createUser(db, { nickname: 'Seeded' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await Promise.allSettled([
      bootstrapOwner(deps, u.id, tg, 'login'),
      seedOwner(db, 'Seeded'),
      bootstrapOwner(deps, u.id, tg, 'login'),
    ]);
    expect(await owners()).toHaveLength(1);
  });

  it('banned or deleted accounts, other providers and mismatched ids are never promoted', async () => {
    const banned = await linkedUser({ isBanned: true });
    expect(await bootstrapOwner(deps, banned.id, tg, 'login')).toBe(false);
    await db.delete(authIdentities);
    const deleted = await linkedUser({ status: 'deleted' });
    expect(await bootstrapOwner(deps, deleted.id, tg, 'login')).toBe(false);
    await db.delete(authIdentities);
    const u = await linkedUser();
    expect(
      await bootstrapOwner(deps, u.id, { provider: 'google', subject: OWNER_TG }, 'login'),
    ).toBe(false);
    expect(await bootstrapOwner(deps, u.id, { provider: 'telegram', subject: '1' }, 'login')).toBe(
      false,
    );
    // Ідентичність не прив'язана до цього акаунта — теж ні (захист у глибину).
    const other = await createUser(db);
    expect(await bootstrapOwner(deps, other.id, tg, 'login')).toBe(false);
    expect(await owners()).toEqual([]);
  });
});
