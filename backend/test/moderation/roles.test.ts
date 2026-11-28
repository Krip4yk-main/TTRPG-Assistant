import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  complaints,
  moderationLog,
  notifications,
  users,
} from '../../src/db/schema/index.js';
import { ROLE_RANK } from '../../src/moderation/permissions.js';
import { runStaffTelegramReminders } from '../../src/moderation/staff-telegram.js';
import { imposeSanction } from '../../src/moderation/sanctions.service.js';
import { deleteAccount } from '../../src/users/users.service.js';
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
const ROLES: Role[] = ['user', 'moderator', 'admin', 'owner'];
const ASSIGNABLE = ['user', 'moderator', 'admin'] as const;

let seq = 0;
/** Користувач із прив'язаним Telegram (персонал — лише з ним, План 20); `telegram: false` — без. */
async function user(role: Role = 'user', nickname = `N${++seq}`, { telegram = true } = {}) {
  const u = await createUser(db, { nickname, role, birthDate: bornYearsAgo(30) });
  if (telegram) {
    await db
      .insert(authIdentities)
      .values({ userId: u.id, provider: 'telegram', subject: `tg-${u.id}` });
  }
  return { ...u, cookie: await login(u.id) };
}
const roleOf = async (id: number) =>
  (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]!.role;

const setRole = (cookie: string, publicId: string, role: string) =>
  call('put', `/api/admin/users/${publicId}/role`, cookie, { role });
const transfer = (cookie: string, toPublicId: string, confirmNickname: string) =>
  call('post', '/api/admin/owner/transfer', cookie, { toPublicId, confirmNickname });

/** Матриця дизайну: адмін+ керує модераторами, адміна — лише власник; ціль — нижча роль. */
function allowed(actor: Role, target: Role, next: (typeof ASSIGNABLE)[number]): boolean {
  if (ROLE_RANK[actor] < ROLE_RANK.admin) return false;
  if (ROLE_RANK[target] >= ROLE_RANK[actor]) return false;
  if ((next === 'admin' || target === 'admin') && actor !== 'owner') return false;
  return true;
}

describe('RF 1 — PUT /api/admin/users/:publicId/role', () => {
  const cases = ROLES.flatMap((actor) =>
    ROLES.flatMap((target) => ASSIGNABLE.map((next) => [actor, target, next] as const)),
  );

  it.each(cases)('%s sets %s → %s', async (actorRole, targetRole, next) => {
    const actor = await user(actorRole);
    const target = await user(targetRole);
    const res = await setRole(actor.cookie, target.publicId, next);
    if (allowed(actorRole, targetRole, next)) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ publicId: target.publicId, role: next });
      expect(await roleOf(target.id)).toBe(next);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MODERATION_FORBIDDEN');
      expect(await roleOf(target.id)).toBe(targetRole);
    }
  });

  it('nobody changes their own role; owner role is not assignable; unknown → 404', async () => {
    const owner = await user('owner');
    const admin = await user('admin');
    expect((await setRole(owner.cookie, owner.publicId, 'admin')).status).toBe(403);
    expect((await setRole(admin.cookie, admin.publicId, 'user')).status).toBe(403);
    const u = await user();
    expect((await setRole(owner.cookie, u.publicId, 'owner')).status).toBe(400);
    expect((await setRole(owner.cookie, 'nobody', 'user')).status).toBe(404);
  });

  it('logs role.change; same role is a no-op without a log entry', async () => {
    const admin = await user('admin');
    const u = await user();
    expect((await setRole(admin.cookie, u.publicId, 'moderator')).status).toBe(200);
    expect((await setRole(admin.cookie, u.publicId, 'moderator')).status).toBe(200);
    const logs = await db.select().from(moderationLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: admin.id,
      action: 'role.change',
      targetType: 'user',
      targetId: u.id,
      meta: { from: 'user', to: 'moderator' },
    });
  });

  it('demote → the next request of the demoted moderator is 403 immediately (cache evicted)', async () => {
    const admin = await user('admin');
    const mod = await user('moderator');
    // Перший запит кешує сесію з роллю moderator.
    expect((await call('get', '/api/admin/appeals', mod.cookie)).status).toBe(200);
    expect((await setRole(admin.cookie, mod.publicId, 'user')).status).toBe(200);
    const after = await call('get', '/api/admin/appeals', mod.cookie);
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe('MODERATION_FORBIDDEN');
    // Підвищення — так само одразу.
    expect((await setRole(admin.cookie, mod.publicId, 'moderator')).status).toBe(200);
    expect((await call('get', '/api/admin/appeals', mod.cookie)).status).toBe(200);
  });

  it('staff only with Telegram: assigning moderator/admin without it → 409, removing the role is fine', async () => {
    const owner = await user('owner');
    const admin = await user('admin');
    const plain = await user('user', 'NoTg', { telegram: false });
    for (const [actor, next] of [
      [admin, 'moderator'],
      [owner, 'moderator'],
      [owner, 'admin'],
    ] as const) {
      const res = await setRole(actor.cookie, plain.publicId, next);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TELEGRAM_REQUIRED');
    }
    expect(await roleOf(plain.id)).toBe('user');
    expect(await db.select().from(moderationLog)).toEqual([]);
    // Наявний персонал без Telegram: роль не знімається сама, але зняти її можна…
    const legacyMod = await user('moderator', 'LegacyMod', { telegram: false });
    const legacyAdmin = await user('admin', 'LegacyAdmin', { telegram: false });
    // …а підвищити/змінити на іншу роль персоналу — ні.
    expect((await setRole(owner.cookie, legacyMod.publicId, 'admin')).status).toBe(409);
    expect((await setRole(owner.cookie, legacyAdmin.publicId, 'moderator')).status).toBe(409);
    // Та сама роль — як і раніше без змін і без помилки.
    expect((await setRole(owner.cookie, legacyMod.publicId, 'moderator')).status).toBe(200);
    expect((await setRole(owner.cookie, legacyMod.publicId, 'user')).status).toBe(200);
    expect(await roleOf(legacyMod.id)).toBe('user');
    // Прав на ціль немає — 403 раніше за 409 (не розкриваємо, чи є Telegram).
    const mod = await user('moderator');
    expect((await setRole(mod.cookie, plain.publicId, 'moderator')).status).toBe(403);
  });

  it('removing the staff role marks the unread «link Telegram» reminder as read', async () => {
    const owner = await user('owner');
    const legacy = await user('moderator', 'LegacyRem', { telegram: false });
    await runStaffTelegramReminders(deps, new Date());
    const unread = () =>
      db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, legacy.id), isNull(notifications.readAt)));
    expect(await unread()).toHaveLength(1);
    expect((await setRole(owner.cookie, legacy.publicId, 'user')).status).toBe(200);
    expect(await unread()).toEqual([]);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('the actor role is read from the DB, not the cached session', async () => {
    const admin = await user('admin');
    const u = await user();
    expect((await call('get', '/api/admin/appeals', admin.cookie)).status).toBe(200);
    // Роль змінено повз сервіс (кеш сесії ще каже «admin»).
    await db.update(users).set({ role: 'moderator' }).where(eq(users.id, admin.id));
    expect((await setRole(admin.cookie, u.publicId, 'moderator')).status).toBe(403);
  });
});

describe('POST /api/admin/owner/transfer', () => {
  it('only to a current admin with the nickname confirmed; old owner → admin, may delete', async () => {
    const owner = await user('owner', 'Owner');
    const admin = await user('admin', 'NewBoss');
    const mod = await user('moderator', 'Mod');

    const notAdmin = await transfer(owner.cookie, mod.publicId, 'Mod');
    expect(notAdmin.status).toBe(400);
    expect(notAdmin.body.error).toMatchObject({
      code: 'OWNER_TRANSFER_INVALID',
      details: { reason: 'NOT_ADMIN' },
    });
    expect((await transfer(owner.cookie, 'nobody', 'x')).status).toBe(400);
    expect((await transfer(owner.cookie, owner.publicId, 'Owner')).status).toBe(400);
    const wrongNick = await transfer(owner.cookie, admin.publicId, 'NewBos');
    expect(wrongNick.status).toBe(400);
    expect(wrongNick.body.error.details).toEqual({ reason: 'NICKNAME_MISMATCH' });
    // Не власник — 403.
    expect((await transfer(admin.cookie, admin.publicId, 'NewBoss')).status).toBe(403);
    expect(await roleOf(owner.id)).toBe('owner');
    expect(await db.select().from(moderationLog)).toEqual([]);

    // Колишній власник не може видалити акаунт…
    await expect(deleteAccount(deps, owner.id)).rejects.toMatchObject({
      code: 'OWNER_CANNOT_DELETE',
    });
    const ok = await transfer(owner.cookie, admin.publicId, '  newboss ');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ publicId: admin.publicId, role: 'owner' });
    expect(await roleOf(admin.id)).toBe('owner');
    expect(await roleOf(owner.id)).toBe('admin');
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({
      actorId: owner.id,
      action: 'owner.transfer',
      targetType: 'user',
      targetId: admin.id,
    });
    // Кеш сесій обох скинуто: колишній власник уже не може передавати, новий — може.
    expect((await transfer(owner.cookie, admin.publicId, 'NewBoss')).status).toBe(403);
    expect((await setRole(admin.cookie, owner.publicId, 'moderator')).status).toBe(200);
    // …а тепер може.
    await deleteAccount(deps, owner.id);
    const [gone] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(gone!.status).toBe('deleted');
  });

  it('an admin without Telegram cannot become the owner (409 TELEGRAM_REQUIRED)', async () => {
    const owner = await user('owner');
    const admin = await user('admin', 'NoTg', { telegram: false });
    const res = await transfer(owner.cookie, admin.publicId, 'NoTg');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TELEGRAM_REQUIRED');
    expect(await roleOf(owner.id)).toBe('owner');
    expect(await roleOf(admin.id)).toBe('admin');
    expect(await db.select().from(moderationLog)).toEqual([]);
  });

  it('a banned admin cannot become the owner', async () => {
    const owner = await user('owner');
    const admin = await user('admin', 'Banned');
    await db.update(users).set({ isBanned: true }).where(eq(users.id, admin.id));
    expect((await transfer(owner.cookie, admin.publicId, 'Banned')).status).toBe(400);
  });
});

describe('admin users: search and card', () => {
  it('search by nickname prefix or publicId; staff only', async () => {
    const mod = await user('moderator', 'Mod');
    const a = await user('user', 'Frodo');
    await user('user', 'Fred');
    await user('user', 'Sam');
    await createUser(db, { status: 'pending', nickname: 'Frozen' });
    const res = await call('get', '/api/admin/users?q=fr', mod.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items.map((u: { nickname: string }) => u.nickname)).toEqual(['Frodo', 'Fred']);
    expect(res.body.items[0]).toEqual({
      publicId: a.publicId,
      nickname: 'Frodo',
      avatarUrl: null,
      role: 'user',
      status: 'active',
      isBanned: false,
      hasTelegram: true,
    });
    const byId = await call('get', `/api/admin/users?q=${a.publicId}`, mod.cookie);
    expect(byId.body.items.map((u: { publicId: string }) => u.publicId)).toEqual([a.publicId]);
    expect((await call('get', '/api/admin/users?q=%25', mod.cookie)).body.items).toEqual([]);
    const page = await call('get', '/api/admin/users?limit=2', mod.cookie);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).not.toBeNull();
    expect((await call('get', '/api/admin/users', a.cookie)).status).toBe(403);
  });

  it('hasTelegram flag in the list and the card (staff without Telegram are flagged)', async () => {
    const owner = await user('owner', 'Boss');
    const legacy = await user('admin', 'LegacyAdmin', { telegram: false });
    const list = await call('get', '/api/admin/users', owner.cookie);
    const flags = Object.fromEntries(
      list.body.items.map((u: { nickname: string; hasTelegram: boolean }) => [
        u.nickname,
        u.hasTelegram,
      ]),
    );
    expect(flags).toEqual({ Boss: true, LegacyAdmin: false });
    const card = await call('get', `/api/admin/users/${legacy.publicId}`, owner.cookie);
    expect(card.body).toMatchObject({ role: 'admin', hasTelegram: false });
    expect(
      (await call('get', `/api/admin/users/${owner.publicId}`, owner.cookie)).body,
    ).toMatchObject({ hasTelegram: true });
  });

  it('card: role, sanctions, complaints — reporter hidden from moderators, shown to admins', async () => {
    const mod = await user('moderator', 'Mod');
    const admin = await user('admin', 'Admin');
    const target = await user('user', 'Target');
    const reporter = await user('user', 'Reporter');
    const s = await imposeSanction(deps, mod.id, target.id, {
      type: 'warning',
      duration: '7d',
      reason: 'Грубість',
    });
    await db.insert(complaints).values({
      reporterId: reporter.id,
      targetUserId: target.id,
      reason: 'harassment',
      message: 'Ображав',
    });
    const asMod = await call('get', `/api/admin/users/${target.publicId}`, mod.cookie);
    expect(asMod.status).toBe(200);
    expect(asMod.body).toMatchObject({
      publicId: target.publicId,
      nickname: 'Target',
      role: 'user',
      status: 'active',
      isBanned: false,
    });
    expect(asMod.body.sanctions.map((x: { id: number }) => x.id)).toEqual([s.id]);
    expect(asMod.body.complaints).toHaveLength(1);
    expect(asMod.body.complaints[0]).toMatchObject({ reason: 'harassment', reporter: null });
    expect(JSON.stringify(asMod.body)).not.toContain(reporter.publicId);
    const asAdmin = await call('get', `/api/admin/users/${target.publicId}`, admin.cookie);
    expect(asAdmin.body.complaints[0].reporter).toMatchObject({ publicId: reporter.publicId });
    expect((await call('get', '/api/admin/users/nope', mod.cookie)).status).toBe(404);
    expect((await call('get', `/api/admin/users/${mod.publicId}`, target.cookie)).status).toBe(403);
  });

  it("card sanctions follow the rank rule: a moderator does not see an admin's or a moderator's sanctions", async () => {
    const owner = await user('owner');
    const mod = await user('moderator');
    const admin = await user('admin');
    const mod2 = await user('moderator');
    const warn = { type: 'warning', duration: '7d', reason: 'r' } as const;
    await imposeSanction(deps, owner.id, admin.id, warn);
    await imposeSanction(deps, owner.id, mod2.id, warn);
    const card = (cookie: string, publicId: string) =>
      call('get', `/api/admin/users/${publicId}`, cookie);
    expect((await card(mod.cookie, admin.publicId)).body.sanctions).toEqual([]);
    expect((await card(mod.cookie, mod2.publicId)).body.sanctions).toEqual([]);
    expect((await card(admin.cookie, mod2.publicId)).body.sanctions).toHaveLength(1);
    expect((await card(owner.cookie, admin.publicId)).body.sanctions).toHaveLength(1);
  });

  it("a moderator does not see complaints about an admin in the admin's card", async () => {
    const mod = await user('moderator');
    const admin = await user('admin');
    const reporter = await user();
    await db.insert(complaints).values({
      reporterId: reporter.id,
      targetUserId: admin.id,
      reason: 'other',
    });
    const card = await call('get', `/api/admin/users/${admin.publicId}`, mod.cookie);
    expect(card.body.complaints).toEqual([]);
  });
});

describe('GET /api/admin/log', () => {
  it('admin+ only; newest first with a cursor; every action is logged', async () => {
    const owner = await user('owner', 'Owner');
    const admin = await user('admin', 'Admin');
    const mod = await user('moderator', 'Mod');
    const u = await user('user', 'U');
    await imposeSanction(deps, mod.id, u.id, { type: 'warning', duration: '7d', reason: 'r' });
    await setRole(admin.cookie, u.publicId, 'moderator');
    await setRole(owner.cookie, u.publicId, 'admin');

    expect((await call('get', '/api/admin/log', mod.cookie)).status).toBe(403);
    expect((await call('get', '/api/admin/log', u.cookie)).status).toBe(200); // тепер адмін
    const res = await call('get', '/api/admin/log', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items.map((l: { action: string }) => l.action)).toEqual([
      'role.change',
      'role.change',
      'sanction.impose',
    ]);
    expect(res.body.items[0]).toMatchObject({
      actor: { publicId: owner.publicId, nickname: 'Owner' },
      targetType: 'user',
      targetUser: { publicId: u.publicId },
      meta: { from: 'moderator', to: 'admin' },
    });
    const p1 = await call('get', '/api/admin/log?limit=2', admin.cookie);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await call(
      'get',
      `/api/admin/log?limit=2&cursor=${p1.body.nextCursor}`,
      admin.cookie,
    );
    expect(p2.body.items.map((l: { action: string }) => l.action)).toEqual(['sanction.impose']);
    expect(p2.body.nextCursor).toBeNull();
    const filtered = await call(
      'get',
      `/api/admin/log?targetType=user&targetId=${mod.id}`,
      admin.cookie,
    );
    expect(filtered.body.items).toEqual([]);
    expect((await call('get', '/api/admin/log?targetType=user', admin.cookie)).status).toBe(400);
  });
});
