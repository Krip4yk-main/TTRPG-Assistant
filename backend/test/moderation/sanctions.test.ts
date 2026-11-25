import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  complaints,
  gameApplications,
  gameMembers,
  games,
  identityTombstones,
  moderationLog,
  notifications,
  sanctions,
  sessions,
  users,
} from '../../src/db/schema/index.js';
import { linkIdentity, resolveLogin } from '../../src/auth/identity.service.js';
import { deleteAccount, unlinkIdentity } from '../../src/users/users.service.js';
import { runDispatch } from '../../src/notifications/dispatcher.js';
import { activeSanctions } from '../../src/moderation/sanctions.enforce.js';
import { expireSanctions, expireSlot } from '../../src/moderation/sanctions.jobs.js';
import { imposeSanction, imposeSanctionTx } from '../../src/moderation/sanctions.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { bornYearsAgo, harness } from '../games/fixtures.js';
import { at, DAY, ratingFixtures } from '../ratings/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { login, call, createGame } = harness(deps, app);
const fx = ratingFixtures(db);

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

const impose = (cookie: string, publicId: string, body: object) =>
  call('post', `/api/admin/users/${publicId}/sanctions`, cookie, body);
const lift = (cookie: string, id: number, body: object = {}) =>
  call('post', `/api/admin/sanctions/${id}/lift`, cookie, body);
const apply = (cookie: string, gameId: number) =>
  call('post', `/api/games/${gameId}/applications`, cookie, {
    warningsAccepted: true,
    answers: [],
  });

async function pendingApp(gameId: number, userId: number) {
  await db.insert(gameApplications).values({
    gameId,
    userId,
    answers: [],
    constraints: [],
    warningsAcceptedAt: new Date(),
  });
}

const tg = (subject: string) => ({ provider: 'telegram', subject, displayName: 'T' }) as const;
const google = (subject: string) => ({ provider: 'google', subject, displayName: 'G' }) as const;

async function withIdentities(
  nickname: string,
  ...ids: { provider: 'telegram' | 'google'; subject: string }[]
) {
  const u = await user(nickname);
  for (const i of ids) await db.insert(authIdentities).values({ userId: u.id, ...i });
  return u;
}

const recruiting = (gmId: number, patch: Partial<typeof games.$inferInsert> = {}) =>
  fx.game(gmId, { status: 'recruiting', startsAt: at(Date.now() + 30 * DAY), ...patch });

describe('RF 1 — rights', () => {
  it('moderator cannot global_ban; admin can; moderator cannot sanction a moderator', async () => {
    const mod = await user('Mod', 'moderator');
    const mod2 = await user('Mod2', 'moderator');
    const admin = await user('Admin', 'admin');
    const bad = await user('Bad');
    const ban = { type: 'global_ban', duration: 'permanent', reason: 'Шахрайство' };
    const r1 = await impose(mod.cookie, bad.publicId, ban);
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect(await db.select().from(sanctions)).toHaveLength(0);
    const warn = { type: 'warning', duration: '7d', reason: 'Грубість' };
    expect((await impose(mod.cookie, mod2.publicId, warn)).status).toBe(403);
    const ok = await impose(mod.cookie, bad.publicId, warn);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ type: 'warning', active: true, reason: 'Грубість' });
    expect((await impose(admin.cookie, bad.publicId, ban)).status).toBe(201);
    // Щойно забанений: перший запит — 403 ACCOUNT_BANNED (екран бану), далі сесій уже немає.
    const banned = await impose(bad.cookie, mod.publicId, warn);
    expect(banned.status).toBe(403);
    expect(banned.body.error.code).toBe('ACCOUNT_BANNED');
    expect((await impose(bad.cookie, mod.publicId, warn)).status).toBe(401);
  });

  it('plain user → 403; unknown publicId → 404; bad body → 400', async () => {
    const u = await user('U');
    const admin = await user('Admin', 'admin');
    const warn = { type: 'warning', duration: '7d', reason: 'x' };
    expect((await impose(u.cookie, admin.publicId, warn)).status).toBe(403);
    expect((await impose(admin.cookie, 'nope', warn)).status).toBe(404);
    expect((await impose(admin.cookie, u.publicId, { type: 'warning' })).status).toBe(400);
  });
});

describe('impose: log, notification, my sanctions', () => {
  it('writes the log, notifies the sanctioned user with type/end/reason; GET /api/me/sanctions', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const res = await impose(mod.cookie, u.publicId, {
      type: 'no_paid_apply',
      duration: '30d',
      reason: 'Неявка',
    });
    expect(res.status).toBe(201);
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({ actorId: mod.id, action: 'sanction.impose', targetId: u.id });
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(n).toMatchObject({ type: 'sanction.imposed', category: 'moderation' });
    expect(n!.payload).toEqual({
      sanctionType: 'no_paid_apply',
      endsAt: res.body.endsAt,
      reason: 'Неявка',
    });
    const mine = await call('get', '/api/me/sanctions', u.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([
      {
        id: res.body.id,
        type: 'no_paid_apply',
        reason: 'Неявка',
        startsAt: res.body.startsAt,
        endsAt: res.body.endsAt,
        appealStatus: null,
      },
    ]);
    // Того, хто наклав, у відповіді немає.
    expect(JSON.stringify(mine.body)).not.toContain(mod.publicId);
  });
});

describe('RF 4 — terms', () => {
  it('a 7-day restriction holds to the last millisecond; the job lifts it at the end', async () => {
    const mod = await user('Mod', 'moderator');
    const u = await user('U');
    const res = await impose(mod.cookie, u.publicId, {
      type: 'application_limit',
      duration: '7d',
      reason: 'Спам заявками',
    });
    const endsAt = new Date(res.body.endsAt as string);
    expect(endsAt.getTime() - new Date(res.body.startsAt as string).getTime()).toBe(7 * DAY);
    const before = new Date(endsAt.getTime() - 1);
    expect(await activeSanctions(db, u.id, before)).toEqual(new Set(['application_limit']));
    expect(await activeSanctions(db, u.id, endsAt)).toEqual(new Set());

    expect(await expireSanctions(deps, before)).toBe(0);
    expect(await expireSanctions(deps, endsAt)).toBe(1);
    expect(await expireSanctions(deps, endsAt)).toBe(0);
    const [s] = await db.select().from(sanctions);
    expect(s!.liftedAt!.getTime()).toBe(endsAt.getTime());
    expect(s!.liftedBy).toBeNull();
    const logs = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.action, 'sanction.expire'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorId).toBeNull();
    const lifted = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, u.id), eq(notifications.type, 'sanction.lifted')));
    expect(lifted).toHaveLength(1);
    // Уже знятої дострокове зняття не чіпає.
    expect((await lift(mod.cookie, s!.id)).body.error.code).toBe('SANCTION_NOT_ACTIVE');
  });

  it('early lift works; second lift → 409; moderator cannot lift a ban', async () => {
    const mod = await user('Mod', 'moderator');
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    const s = await impose(mod.cookie, u.publicId, {
      type: 'no_paid_create',
      duration: 'permanent',
      reason: 'Обман з оплатою',
    });
    expect(s.body.endsAt).toBeNull();
    const r = await lift(mod.cookie, s.body.id as number, { note: 'Розібрались' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: false, liftedBy: { publicId: mod.publicId } });
    expect(await activeSanctions(db, u.id)).toEqual(new Set());
    expect((await lift(mod.cookie, s.body.id as number)).status).toBe(409);
    const [log] = await db
      .select()
      .from(moderationLog)
      .where(eq(moderationLog.action, 'sanction.lift'));
    expect(log).toMatchObject({ actorId: mod.id, reason: 'Розібрались' });

    const ban = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: '7d',
      reason: 'Погрози',
    });
    const denied = await lift(mod.cookie, ban.body.id as number);
    expect(denied.status).toBe(403);
    expect((await lift(admin.cookie, ban.body.id as number)).status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after!.isBanned).toBe(false);
  });

  it('temporary ban expires: is_banned cleared, tombstones unmarked, login works again', async () => {
    const admin = await user('Admin', 'admin');
    const u = await withIdentities('U', tg('100'), google('g100'));
    await unlinkIdentity(deps, u.id, 'telegram');
    const res = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: '7d',
      reason: 'Погрози',
    });
    await expect(resolveLogin(deps, tg('100'))).rejects.toMatchObject({ code: 'IDENTITY_BANNED' });
    expect(await expireSanctions(deps, new Date(res.body.endsAt as string))).toBe(1);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after!.isBanned).toBe(false);
    expect((await resolveLogin(deps, tg('100'))).isNew).toBe(true);
  });

  it('lifting one ban keeps the user banned while another ban is active', async () => {
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    const b1 = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: '7d',
      reason: 'Перший',
    });
    // Другий бан через API — 409: уже забанений.
    const dup = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Другий',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toEqual({
      code: 'SANCTION_ACTIVE',
      details: { type: 'global_ban', endsAt: b1.body.endsAt },
    });
    expect(await db.select().from(sanctions)).toHaveLength(1);
    // Перекриття банів (напр. перенесені міграцією) — зняття одного лишає бан.
    await db.insert(sanctions).values({
      userId: u.id,
      type: 'global_ban',
      reason: 'Другий',
      imposedBy: admin.id,
      startsAt: new Date(),
      endsAt: null,
    });
    expect((await lift(admin.cookie, b1.body.id as number)).status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after!.isBanned).toBe(true);
    expect(after!.banEpoch).toBe(1);
  });
});

describe('RF 3 — ban evasion', () => {
  it('unlink → ban → re-register with the same Telegram → IDENTITY_BANNED; unban → allowed', async () => {
    const admin = await user('Admin', 'admin');
    const u = await withIdentities('Evader', tg('777'), google('g777'));
    await unlinkIdentity(deps, u.id, 'telegram');
    const [t] = await db.select().from(identityTombstones);
    expect(t).toMatchObject({ userId: u.id, isBanned: false });
    // До бану надгробок не заважає.
    const other = await user('Other');
    const ban = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Шахрайство',
    });
    expect(ban.status).toBe(201);
    await expect(resolveLogin(deps, tg('777'))).rejects.toMatchObject({
      status: 403,
      code: 'IDENTITY_BANNED',
    });
    await expect(linkIdentity(deps, other.id, tg('777'))).rejects.toMatchObject({
      code: 'IDENTITY_BANNED',
    });
    expect((await lift(admin.cookie, ban.body.id as number)).status).toBe(200);
    const [t2] = await db.select().from(identityTombstones);
    expect(t2!.isBanned).toBe(false);
    await linkIdentity(deps, other.id, tg('777'));
    expect((await resolveLogin(deps, tg('777'))).userId).toBe(other.id);
  });

  it('banning a deleted account marks its tombstones', async () => {
    const admin = await user('Admin', 'admin');
    const u = await withIdentities('Gone', tg('555'));
    await deleteAccount(deps, u.id);
    const [t] = await db.select().from(identityTombstones);
    expect(t).toMatchObject({ userId: u.id, isBanned: false });
    const res = await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Ухилення',
    });
    expect(res.status).toBe(201);
    await expect(resolveLogin(deps, tg('555'))).rejects.toMatchObject({ code: 'IDENTITY_BANNED' });
    // Менші санкції видаленому — немає сенсу.
    const warn = await impose(admin.cookie, u.publicId, {
      type: 'warning',
      duration: '7d',
      reason: 'x',
    });
    expect(warn.status).toBe(404);
  });

  it('another account that already has the identity is unaffected by the ban', async () => {
    const admin = await user('Admin', 'admin');
    const a = await withIdentities('A', tg('42'), google('ga'));
    await unlinkIdentity(deps, a.id, 'telegram');
    const b = await user('B');
    await linkIdentity(deps, b.id, tg('42'));
    await impose(admin.cookie, a.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Бан',
    });
    expect(await resolveLogin(deps, tg('42'))).toEqual({ userId: b.id, isNew: false });
  });
});

describe('global ban: sessions, cascade, blocked flag', () => {
  it('mid-session ban: next request → 403 ACCOUNT_BANNED with an appeal token, then sessions revoked', async () => {
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    expect((await call('get', '/api/me', u.cookie)).status).toBe(200);
    await impose(admin.cookie, u.publicId, {
      type: 'global_ban',
      duration: '30d',
      reason: 'Бан',
    });
    // Кеш сесії скинуто, сама сесія ще є — перший запит бачить бан і отримує екран апеляції.
    const banned = await call('get', '/api/me', u.cookie);
    expect(banned.status).toBe(403);
    expect(banned.body.error.code).toBe('ACCOUNT_BANNED');
    expect(banned.body.error.details).toMatchObject({
      appealToken: expect.any(String),
      appealSent: false,
      appealStatus: null,
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    expect((await call('get', '/api/me', u.cookie)).status).toBe(401);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row).toMatchObject({ isBanned: true, banEpoch: 1 });
  });

  it('RF 5: banning a GM cancels their active games and players get the normal notification', async () => {
    const admin = await user('Admin', 'admin');
    const gm = await user('GM');
    const player = await user('Player');
    const applicant = await user('Applicant');
    const started = await fx.game(gm.id, { title: 'Стара' });
    await fx.member(started, player.id, at(Date.now() - 10 * DAY));
    const rec = await recruiting(gm.id, { title: 'Нова' });
    await pendingApp(rec, applicant.id);
    const finished = await fx.game(gm.id, { status: 'finished' });

    const res = await impose(admin.cookie, gm.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Шахрайство',
    });
    expect(res.status).toBe(201);
    const statuses = await db.select({ id: games.id, status: games.status }).from(games);
    expect(new Map(statuses.map((g) => [g.id, g.status]))).toEqual(
      new Map([
        [started, 'cancelled'],
        [rec, 'cancelled'],
        [finished, 'finished'],
      ]),
    );
    const [app2] = await db.select().from(gameApplications);
    expect(app2!.status).toBe('cancelled');

    await runDispatch(deps);
    const got = await db
      .select({ type: notifications.type, payload: notifications.payload })
      .from(notifications)
      .where(eq(notifications.userId, player.id));
    expect(got.map((n) => n.type)).toContain('game.cancelled');
    const appNotes = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, applicant.id));
    expect(appNotes.map((n) => n.type)).toContain('application.cancelled_game');
    // Профіль і минулі ігри видно з позначкою.
    const profile = await call('get', `/api/users/${gm.publicId}`, player.cookie);
    expect(profile.status).toBe(200);
    expect(profile.body.blocked).toBe(true);
    const view = await call('get', `/api/games/${finished}`, player.cookie);
    expect(view.body.game?.gm?.blocked ?? view.body.gm?.blocked).toBe(true);
  });

  it('RF 5: banning a player withdraws applications and removes them from games (banned_by_admin)', async () => {
    const admin = await user('Admin', 'admin');
    const gm = await user('GM');
    const p = await user('P');
    const g1 = await fx.game(gm.id);
    await fx.member(g1, p.id, at(Date.now() - 10 * DAY));
    const g2 = await recruiting(gm.id);
    await pendingApp(g2, p.id);
    await impose(admin.cookie, p.publicId, {
      type: 'global_ban',
      duration: '7d',
      reason: 'Погрози',
    });
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m).toMatchObject({ leftReason: 'banned_by_admin' });
    expect(m!.leftAt).not.toBeNull();
    const [a] = await db.select().from(gameApplications);
    expect(a!.status).toBe('withdrawn');
    expect((await db.select().from(games)).every((g) => g.status !== 'cancelled')).toBe(true);
    await runDispatch(deps);
    const gmNotes = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, gm.id));
    expect(gmNotes.map((n) => n.type).sort()).toEqual(['application.withdrawn', 'member.left']);
    // Після закінчення бану нічого не відновлюється.
    await expireSanctions(deps, new Date(Date.now() + 8 * DAY));
    const [m2] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m2!.leftReason).toBe('banned_by_admin');
    const [a2] = await db.select().from(gameApplications);
    expect(a2!.status).toBe('withdrawn');
  });

  it('a sanction inside an outer transaction that rolls back: no sanction, no revoked session', async () => {
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    let after: (() => Promise<void>) | null = null;
    await expect(
      db.transaction(async (tx) => {
        const r = await imposeSanctionTx(deps, tx, admin.id, u.id, {
          type: 'global_ban',
          duration: 'permanent',
          reason: 'Бан',
        });
        after = r.afterCommit;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(after).not.toBeNull();
    expect(await db.select().from(sanctions)).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(1);
    expect((await call('get', '/api/me', u.cookie)).status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.isBanned).toBe(false);
  });
});

describe('RF 5 — lesser sanctions block only new actions', () => {
  it('application_limit: existing pending apps stay; a new one → 409 while ≥ 1 pending', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('GM');
    const p = await user('P');
    const g1 = await recruiting(gm.id);
    const g2 = await recruiting(gm.id);
    const g3 = await recruiting(gm.id);
    await pendingApp(g1, p.id);
    await pendingApp(g2, p.id);
    const s = await impose(mod.cookie, p.publicId, {
      type: 'application_limit',
      duration: '30d',
      reason: 'Спам',
    });
    const apps = await db.select().from(gameApplications);
    expect(apps.every((a) => a.status === 'pending')).toBe(true);
    const r = await apply(p.cookie, g3);
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({
      code: 'SANCTION_ACTIVE',
      details: { type: 'application_limit', endsAt: s.body.endsAt },
    });
    await db.update(gameApplications).set({ status: 'withdrawn' });
    expect((await apply(p.cookie, g3)).status).toBe(201);
    // Членства не рахуються — лише заявки, що очікують.
    expect((await apply(p.cookie, g1)).status).toBe(409);
  });

  it('no_paid_apply: paid game → 409; free game → OK; existing paid membership untouched', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('GM');
    const p = await user('P');
    const paidStarted = await fx.game(gm.id, { priceUah: 300 });
    await fx.member(paidStarted, p.id, at(Date.now() - DAY));
    const paid = await recruiting(gm.id, { priceUah: 200 });
    const free = await recruiting(gm.id, { priceUah: 0 });
    await impose(mod.cookie, p.publicId, {
      type: 'no_paid_apply',
      duration: 'permanent',
      reason: 'Неоплата',
    });
    const r = await apply(p.cookie, paid);
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ type: 'no_paid_apply', endsAt: null });
    expect((await apply(p.cookie, free)).status).toBe(201);
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m!.leftAt).toBeNull();
  });

  it('no_paid_create: new paid game → 409, free OK, free→paid → 409, paid stays paid and editable', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('GM');
    const paidId = await createGame(gm.cookie, { priceUah: 500 });
    await impose(mod.cookie, gm.publicId, {
      type: 'no_paid_create',
      duration: '90d',
      reason: 'Обман',
    });
    const c = await call('post', '/api/games', gm.cookie, {
      ...(await harness(deps, app).validGame({ priceUah: 100 })),
    });
    expect(c.status).toBe(409);
    expect(c.body.error.details.type).toBe('no_paid_create');
    const freeId = await createGame(gm.cookie, { priceUah: 0 });
    const toPaid = await call('patch', `/api/games/${freeId}`, gm.cookie, { priceUah: 50 });
    expect(toPaid.status).toBe(409);
    expect(toPaid.body.error.code).toBe('SANCTION_ACTIVE');
    const keep = await call('patch', `/api/games/${paidId}`, gm.cookie, { priceUah: 700 });
    expect(keep.status).toBe(200);
    const [g] = await db.select().from(games).where(eq(games.id, paidId));
    expect(g!.priceUah).toBe(700);
  });

  it('warning changes nothing and blocks nothing', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('GM');
    const p = await user('P');
    const g = await recruiting(gm.id, { priceUah: 100 });
    await impose(mod.cookie, p.publicId, { type: 'warning', duration: '7d', reason: 'Увага' });
    expect((await apply(p.cookie, g)).status).toBe(201);
  });
});

describe('imposeSanction (own transaction)', () => {
  it('returns the DTO and runs side effects after commit', async () => {
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    const dto = await imposeSanction(deps, admin.id, u.id, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Бан',
    });
    expect(dto).toMatchObject({ type: 'global_ban', active: true, imposedBy: { role: 'admin' } });
    // Після коміту скинуто кеш сесії: наступний запит бачить бан.
    expect((await call('get', '/api/me', u.cookie)).body.error.code).toBe('ACCOUNT_BANNED');
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
  });
});

describe('Task 3 review: races and notices', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it.each(['direct', 'complaint'] as const)(
    'an approval committed while the ban (%s) waits on the game lock still removes the user',
    async (path) => {
      const admin = await user('Admin', 'admin');
      const gm = await user('GM');
      const p = await user('P');
      const g = await recruiting(gm.id);
      await pendingApp(g, p.id);
      const [c] = await db
        .insert(complaints)
        .values({ reporterId: gm.id, targetUserId: p.id, reason: 'scam' })
        .$returningId();

      let locked!: () => void;
      const lockedP = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // «Затвердження» в іншій транзакції: тримає X на грі, поки бан чекає на неї.
      const approval = db.transaction(async (tx) => {
        await tx.select({ id: games.id }).from(games).where(eq(games.id, g)).for('update');
        locked();
        await gate;
        await tx
          .update(gameApplications)
          .set({ status: 'approved', decidedAt: new Date() })
          .where(eq(gameApplications.gameId, g));
        await tx.insert(gameMembers).values({ gameId: g, userId: p.id, joinedAt: new Date() });
      });
      await lockedP;
      const sanction = { type: 'global_ban', duration: 'permanent', reason: 'Шахрайство' };
      const ban =
        path === 'direct'
          ? imposeSanction(deps, admin.id, p.id, sanction)
          : call('post', `/api/admin/complaints/${c!.id}/action`, admin.cookie, { sanction });
      await sleep(300);
      release();
      await approval;
      await ban;
      const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
      expect(m!.leftAt).not.toBeNull();
      expect(m!.leftReason).toBe('banned_by_admin');
    },
  );

  it('application_limit: two parallel applications → one 201, one 409', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('GM');
    const p = await user('P');
    const g1 = await recruiting(gm.id);
    const g2 = await recruiting(gm.id);
    await impose(mod.cookie, p.publicId, {
      type: 'application_limit',
      duration: '30d',
      reason: 'Спам',
    });
    const res = await Promise.all([apply(p.cookie, g1), apply(p.cookie, g2)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const pending = await db
      .select()
      .from(gameApplications)
      .where(eq(gameApplications.status, 'pending'));
    expect(pending).toHaveLength(1);
  });

  it('lifting a ban of a user that is no longer banned sends no sanction.lifted', async () => {
    const admin = await user('Admin', 'admin');
    const u = await user('U');
    const s = await imposeSanction(deps, admin.id, u.id, {
      type: 'global_ban',
      duration: '7d',
      reason: 'Бан',
    });
    await db.update(users).set({ isBanned: false }).where(eq(users.id, u.id));
    expect((await lift(admin.cookie, s.id)).status).toBe(200);
    const lifted = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, u.id), eq(notifications.type, 'sanction.lifted')));
    expect(lifted).toEqual([]);
  });

  it("players' notices about a banned GM carry no ban reason", async () => {
    const admin = await user('Admin', 'admin');
    const gm = await user('GM');
    const player = await user('Player');
    const g = await fx.game(gm.id);
    await fx.member(g, player.id, at(Date.now() - 10 * DAY));
    await impose(admin.cookie, gm.publicId, {
      type: 'global_ban',
      duration: 'permanent',
      reason: 'Шахрайство',
    });
    await runDispatch(deps);
    const [n] = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, player.id), eq(notifications.type, 'game.cancelled')));
    expect(n!.payload.reason ?? null).toBeNull();
    expect(JSON.stringify(n!.payload)).not.toContain('banned_by_admin');
  });

  it('expire job slot: never earlier than now', () => {
    const now = new Date('2026-11-25T10:00:30.000Z');
    expect(expireSlot(new Date('2026-11-25T10:00:00.000Z'), now)).toEqual(now);
    const later = new Date('2026-11-25T10:01:00.000Z');
    expect(expireSlot(later, now)).toEqual(later);
  });
});
