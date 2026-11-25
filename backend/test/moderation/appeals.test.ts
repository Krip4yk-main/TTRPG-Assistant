import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  moderationLog,
  notifications,
  sanctionAppeals,
  sanctions,
  users,
} from '../../src/db/schema/index.js';
import { createBanAppeal } from '../../src/moderation/appeals.service.js';
import { imposeSanction, liftSanction } from '../../src/moderation/sanctions.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { bornYearsAgo, harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { login, call } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

type Role = 'user' | 'moderator' | 'admin' | 'owner';

async function user(nickname: string, role: Role = 'user') {
  const u = await createUser(db, { nickname, role, birthDate: bornYearsAgo(30) });
  return { ...u, cookie: await login(u.id) };
}

const warn = { type: 'warning', duration: '7d', reason: 'Грубість' } as const;
const ban = { type: 'global_ban', duration: '30d', reason: 'Шахрайство' } as const;

const appealMine = (cookie: string, id: number, message = 'Це непорозуміння') =>
  call('post', `/api/me/sanctions/${id}/appeal`, cookie, { message });
const decide = (cookie: string, id: number, body: object) =>
  call('post', `/api/admin/appeals/${id}/decide`, cookie, body);
const list = (cookie: string, qs = '') => call('get', `/api/admin/appeals${qs}`, cookie);

async function appealRow(sanctionId: number) {
  const [a] = await db
    .select()
    .from(sanctionAppeals)
    .where(eq(sanctionAppeals.sanctionId, sanctionId));
  return a!;
}

describe('POST /api/me/sanctions/:id/appeal', () => {
  it('one appeal per sanction; 409 APPEAL_EXISTS; my sanctions show the status', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const s = await imposeSanction(deps, mod.id, u.id, warn);
    const res = await appealMine(u.cookie, s.id, '  Я не грубіянив  ');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: s.id, type: 'warning', appealStatus: 'pending' });
    expect(await appealRow(s.id)).toMatchObject({
      userId: u.id,
      message: 'Я не грубіянив',
      status: 'pending',
    });
    const dup = await appealMine(u.cookie, s.id, 'ще раз');
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('APPEAL_EXISTS');
    expect(await db.select().from(sanctionAppeals)).toHaveLength(1);
    const mine = await call('get', '/api/me/sanctions', u.cookie);
    expect(mine.body[0].appealStatus).toBe('pending');
  });

  it("someone else's / unknown → 404; lifted → 409 SANCTION_NOT_ACTIVE; bad body → 400", async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const other = await user('Other');
    const s = await imposeSanction(deps, mod.id, u.id, warn);
    expect((await appealMine(other.cookie, s.id)).status).toBe(404);
    expect((await appealMine(u.cookie, 999_999)).status).toBe(404);
    expect((await appealMine(u.cookie, s.id, '   ')).status).toBe(400);
    expect((await appealMine(u.cookie, s.id, 'x'.repeat(2001))).status).toBe(400);
    await liftSanction(deps, mod.id, s.id);
    const lifted = await appealMine(u.cookie, s.id);
    expect(lifted.status).toBe(409);
    expect(lifted.body.error.code).toBe('SANCTION_NOT_ACTIVE');
  });
});

describe('admin appeals', () => {
  it('accept lifts the sanction, logs the decision, notifies appeal.decided only', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const s = await imposeSanction(deps, mod.id, u.id, {
      type: 'no_paid_apply',
      duration: '30d',
      reason: 'Неявка',
    });
    await appealMine(u.cookie, s.id);
    const a = await appealRow(s.id);
    const res = await decide(mod.cookie, a.id, { accept: true, note: 'Перевірили — помилка' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: a.id,
      status: 'accepted',
      decisionNote: 'Перевірили — помилка',
      decidedBy: { publicId: mod.publicId },
      user: { publicId: u.publicId },
      sanctionType: 'no_paid_apply',
    });
    const [row] = await db.select().from(sanctions).where(eq(sanctions.id, s.id));
    expect(row!.liftedAt).not.toBeNull();
    expect(row!.liftedBy).toBe(mod.id);
    const actions = (await db.select().from(moderationLog)).map((l) => l.action);
    expect(actions).toEqual(['sanction.impose', 'sanction.lift', 'appeal.accept']);
    const notes = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(notes.map((n) => n.type).sort()).toEqual(['appeal.decided', 'sanction.imposed']);
    const decided = notes.find((n) => n.type === 'appeal.decided')!;
    expect(decided.category).toBe('moderation');
    expect(decided.payload).toEqual({
      sanctionType: 'no_paid_apply',
      accepted: true,
      reason: 'Перевірили — помилка',
    });
    // Вирішену вдруге — 409.
    const again = await decide(mod.cookie, a.id, { accept: false });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('APPEAL_DECIDED');
    expect((await call('get', '/api/me/sanctions', u.cookie)).body).toEqual([]);
  });

  it('reject keeps the sanction; notification says rejected; log appeal.reject', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const s = await imposeSanction(deps, mod.id, u.id, warn);
    await appealMine(u.cookie, s.id);
    const a = await appealRow(s.id);
    const res = await decide(mod.cookie, a.id, { accept: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    const [row] = await db.select().from(sanctions).where(eq(sanctions.id, s.id));
    expect(row!.liftedAt).toBeNull();
    const [n] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'appeal.decided'));
    expect(n!.payload).toEqual({ sanctionType: 'warning', accepted: false });
    const [log] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.action, 'appeal.reject'));
    expect(log).toMatchObject({ actorId: mod.id, targetType: 'appeal', targetId: a.id });
    expect((await call('get', '/api/me/sanctions', u.cookie)).body[0].appealStatus).toBe(
      'rejected',
    );
  });

  it('ban appeals: hidden from moderators (list and decide), admin accepts → unbanned', async () => {
    const mod = await user('Mod', 'moderator');
    const admin = await user('Admin', 'admin');
    const bad = await createUser(db, { nickname: 'Bad', birthDate: bornYearsAgo(30) });
    const u = await user('U');
    const s = await imposeSanction(deps, admin.id, bad.id, ban);
    const w = await imposeSanction(deps, mod.id, u.id, warn);
    await db.insert(sanctionAppeals).values({ sanctionId: s.id, userId: bad.id, message: 'прошу' });
    await appealMine(u.cookie, w.id);
    const banAppeal = await appealRow(s.id);

    const modList = await list(mod.cookie);
    expect(modList.status).toBe(200);
    expect(modList.body.items.map((x: { sanctionId: number }) => x.sanctionId)).toEqual([w.id]);
    const adminList = await list(admin.cookie, '?status=pending');
    expect(adminList.body.items).toHaveLength(2);
    expect((await list(admin.cookie, '?status=accepted')).body.items).toEqual([]);
    expect((await decide(mod.cookie, banAppeal.id, { accept: true })).status).toBe(404);

    const ok = await decide(admin.cookie, banAppeal.id, { accept: true });
    expect(ok.status).toBe(200);
    const [fresh] = await db.select().from(users).where(eq(users.id, bad.id));
    expect(fresh!.isBanned).toBe(false);
    const cookie = await login(bad.id);
    expect((await call('get', '/api/me', cookie)).status).toBe(200);
  });

  it("rank: a moderator cannot decide an appeal on a moderator's sanction; user → 403", async () => {
    const admin = await user('Admin', 'admin');
    const mod = await user('Mod', 'moderator');
    const mod2 = await user('Mod2', 'moderator');
    const s = await imposeSanction(deps, admin.id, mod2.id, warn);
    await appealMine(mod2.cookie, s.id);
    const a = await appealRow(s.id);
    expect((await list(mod.cookie)).body.items).toEqual([]);
    expect((await decide(mod.cookie, a.id, { accept: true })).status).toBe(404);
    // Сам оскаржувач (модератор) не вирішує власну апеляцію.
    expect((await decide(mod2.cookie, a.id, { accept: true })).status).toBe(404);
    const plain = await user('Plain');
    expect((await list(plain.cookie)).status).toBe(403);
    expect((await decide(plain.cookie, a.id, { accept: true })).status).toBe(403);
    expect((await decide(admin.cookie, a.id, { accept: true })).status).toBe(200);
  });

  it('accepting an appeal on an expired sanction only records the decision', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const s = await imposeSanction(deps, mod.id, u.id, warn);
    await appealMine(u.cookie, s.id);
    await db
      .update(sanctions)
      .set({ endsAt: new Date(Date.now() - 1000) })
      .where(eq(sanctions.id, s.id));
    const a = await appealRow(s.id);
    const res = await decide(mod.cookie, a.id, { accept: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    const actions = (await db.select().from(moderationLog)).map((l) => l.action);
    expect(actions).toEqual(['sanction.impose', 'appeal.accept']);
  });

  it('token appeal on an expired-but-not-yet-lifted ban: lifted inline, 409, no new sanction', async () => {
    const admin = await user('Admin', 'admin');
    const bad = await createUser(db, { nickname: 'Bad', birthDate: bornYearsAgo(30) });
    const s = await imposeSanction(deps, admin.id, bad.id, ban);
    await db
      .update(sanctions)
      .set({
        startsAt: new Date(Date.now() - 40 * 86_400_000),
        endsAt: new Date(Date.now() - 1000),
      })
      .where(eq(sanctions.id, s.id));
    await expect(createBanAppeal(deps, bad.id, 'прошу')).rejects.toMatchObject({
      status: 409,
      code: 'SANCTION_NOT_ACTIVE',
    });
    expect(await db.select().from(sanctions)).toHaveLength(1);
    expect(await db.select().from(sanctionAppeals)).toEqual([]);
    const [row] = await db.select().from(sanctions);
    expect(row!.liftedAt).not.toBeNull();
    const [u] = await db.select().from(users).where(eq(users.id, bad.id));
    expect(u!.isBanned).toBe(false);
    const [log] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.action, 'sanction.expire'));
    expect(log).toMatchObject({ actorId: null, targetId: bad.id });
  });

  it('token appeal re-checks is_banned under the lock', async () => {
    const u = await createUser(db, { nickname: 'Free' });
    await expect(createBanAppeal(deps, u.id, 'прошу')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(await db.select().from(sanctions)).toEqual([]);
  });
});
