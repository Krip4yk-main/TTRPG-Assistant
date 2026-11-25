import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  complaints,
  users,
  gameApplications,
  moderationLog,
  notifications,
  sanctions,
  telegramOutbox,
  authIdentities,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';
import { at, DAY, ratingFixtures } from '../ratings/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { login, call } = harness(deps, app);
const fx = ratingFixtures(db);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const ago = (d: number) => at(Date.now() - d * DAY);
type Role = 'user' | 'moderator' | 'admin' | 'owner';

async function user(nickname: string, role: Role = 'user') {
  const u = await createUser(db, { nickname, role });
  return { ...u, cookie: await login(u.id) };
}

async function apply(gameId: number, userId: number, status: 'pending' | 'rejected' = 'pending') {
  await db.insert(gameApplications).values({
    gameId,
    userId,
    status,
    answers: [],
    constraints: [],
    warningsAcceptedAt: new Date(),
  });
}

const complain = (cookie: string, body: object) => call('post', '/api/complaints', cookie, body);
const queue = (cookie: string, qs = '') => call('get', `/api/admin/complaints${qs}`, cookie);

/** Скарга напряму в БД (для тестів черги). */
async function seedComplaint(
  reporterId: number,
  target: { userId?: number; gameId?: number },
  status: 'new' | 'dismissed' | 'actioned' = 'new',
): Promise<number> {
  const [r] = await db
    .insert(complaints)
    .values({
      reporterId,
      targetUserId: target.userId ?? null,
      targetGameId: target.gameId ?? null,
      reason: 'harassment',
      message: 'Текст',
      status,
    })
    .$returningId();
  return r!.id;
}

describe('POST /api/complaints — who may complain about a person', () => {
  it('shared game (both members, incl. former) → 201; stores the complaint', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const b = await user('Beta');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(30), ago(20)); // колишній
    await fx.member(gameId, b.id, ago(10));
    const res = await complain(a.cookie, {
      targetUserId: b.publicId,
      reason: 'harassment',
      message: '  Образи в чаті  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number) });
    const [row] = await db.select().from(complaints);
    expect(row).toMatchObject({
      reporterId: a.id,
      targetUserId: b.id,
      targetGameId: null,
      reason: 'harassment',
      message: 'Образи в чаті',
      status: 'new',
      resolvedBy: null,
    });
    // Колишня учасниця — теж.
    expect((await complain(b.cookie, { targetUserId: a.publicId, reason: 'other' })).status).toBe(
      201,
    );
  });

  it('member ↔ GM of a shared game (either direction, incl. former member) → 201', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const gameId = await fx.game(gm.id, { status: 'finished', finishedAt: ago(1) });
    await fx.member(gameId, a.id, ago(30), ago(5), 'kicked');
    expect(
      (await complain(a.cookie, { targetUserId: gm.publicId, reason: 'no_show' })).status,
    ).toBe(201);
    expect((await complain(gm.cookie, { targetUserId: a.publicId, reason: 'scam' })).status).toBe(
      201,
    );
  });

  it('target applied to my game → 201; I applied to the target’s game → 201', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const other = await user('Other');
    const gameId = await fx.game(gm.id, { status: 'recruiting' });
    await apply(gameId, a.id, 'rejected');
    // Майстер — на заявника.
    expect((await complain(gm.cookie, { targetUserId: a.publicId, reason: 'other' })).status).toBe(
      201,
    );
    // Заявник — на майстра гри, на яку подавався.
    expect(
      (await complain(a.cookie, { targetUserId: gm.publicId, reason: 'agreement_violation' }))
        .status,
    ).toBe(201);
    // Сторонній — ні на майстра, ні на заявника.
    for (const t of [gm, a]) {
      const r = await complain(other.cookie, { targetUserId: t.publicId, reason: 'other' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('COMPLAINT_NOT_ALLOWED');
    }
  });

  it('two applicants to the same game (no shared membership) → 403', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const b = await user('Beta');
    const gameId = await fx.game(gm.id, { status: 'recruiting' });
    await apply(gameId, a.id);
    await apply(gameId, b.id);
    const r = await complain(a.cookie, { targetUserId: b.publicId, reason: 'other' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('COMPLAINT_NOT_ALLOWED');
  });

  it('strangers, self → 403 COMPLAINT_NOT_ALLOWED; unknown / deleted / pending target → 404', async () => {
    const a = await user('Alpha');
    const b = await user('Beta');
    const r1 = await complain(a.cookie, { targetUserId: b.publicId, reason: 'other' });
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('COMPLAINT_NOT_ALLOWED');
    const self = await complain(a.cookie, { targetUserId: a.publicId, reason: 'other' });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('COMPLAINT_NOT_ALLOWED');
    expect((await complain(a.cookie, { targetUserId: 'nope000000', reason: 'other' })).status).toBe(
      404,
    );
    const gone = await createUser(db, { status: 'deleted' });
    const pending = await createUser(db, { status: 'pending' });
    // Навіть зі спільною грою.
    const gameId = await fx.game(a.id);
    await fx.member(gameId, gone.id, ago(10));
    await fx.member(gameId, pending.id, ago(10));
    for (const t of [gone, pending]) {
      expect((await complain(a.cookie, { targetUserId: t.publicId, reason: 'other' })).status).toBe(
        404,
      );
    }
    expect(await db.select().from(complaints)).toEqual([]);
  });
});

describe('POST /api/complaints — about a game', () => {
  it('any user may complain about a visible game; hidden → 404; own game → 403', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const published = await fx.game(gm.id, { status: 'recruiting' });
    const draft = await fx.game(gm.id, { status: 'draft', publishedAt: null });
    const r = await complain(a.cookie, {
      targetGameId: published,
      reason: 'inappropriate_content',
    });
    expect(r.status).toBe(201);
    expect((await complain(a.cookie, { targetGameId: draft, reason: 'other' })).status).toBe(404);
    expect((await complain(a.cookie, { targetGameId: 999_999, reason: 'other' })).status).toBe(404);
    const own = await complain(gm.cookie, { targetGameId: published, reason: 'other' });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('COMPLAINT_NOT_ALLOWED');
  });

  it('validation: exactly one target, known reason, text ≤ 2000; auth + active profile', async () => {
    const a = await user('Alpha');
    for (const body of [
      { reason: 'other' },
      { targetUserId: 'x', targetGameId: 1, reason: 'other' },
      { targetGameId: 1, reason: 'spam' },
      { targetGameId: 1, reason: 'other', message: 'a'.repeat(2001) },
    ]) {
      const r = await complain(a.cookie, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION');
    }
    expect((await complain('', { targetGameId: 1, reason: 'other' })).status).toBe(401);
    const p = await createUser(db, { status: 'pending' });
    const r = await complain(await login(p.id), { targetGameId: 1, reason: 'other' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PROFILE_INCOMPLETE');
  });
});

describe('GET /api/admin/complaints — staff queue visibility', () => {
  async function world() {
    const owner = await user('Owner', 'owner');
    const admin = await user('Admin', 'admin');
    const admin2 = await user('Admin2', 'admin');
    const mod = await user('Mod', 'moderator');
    const mod2 = await user('Mod2', 'moderator');
    const plain = await user('Plain');
    const reporter = await user('Reporter');
    const gameId = await fx.game(plain.id, { status: 'recruiting' });
    const ids = {
      plain: await seedComplaint(reporter.id, { userId: plain.id }),
      game: await seedComplaint(reporter.id, { gameId }),
      mod: await seedComplaint(reporter.id, { userId: mod.id }),
      mod2: await seedComplaint(reporter.id, { userId: mod2.id }),
      admin: await seedComplaint(reporter.id, { userId: admin.id }),
      admin2: await seedComplaint(reporter.id, { userId: admin2.id }),
      owner: await seedComplaint(reporter.id, { userId: owner.id }),
    };
    return { owner, admin, admin2, mod, mod2, plain, reporter, gameId, ids };
  }
  const idsOf = (body: { items: { id: number }[] }) => body.items.map((i) => i.id).sort();

  it('moderator: users and games; admin: + moderators; owner: everything', async () => {
    const w = await world();
    const { ids } = w;
    const m = await queue(w.mod.cookie);
    expect(m.status).toBe(200);
    expect(idsOf(m.body)).toEqual([ids.plain, ids.game].sort());
    const a = await queue(w.admin.cookie);
    expect(idsOf(a.body)).toEqual([ids.plain, ids.game, ids.mod, ids.mod2].sort());
    const o = await queue(w.owner.cookie);
    expect(idsOf(o.body)).toEqual(Object.values(ids).sort());
  });

  it('plain users get 403; DTO shows reporter, target and game to staff; newest first', async () => {
    const w = await world();
    const r = await queue(w.plain.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await queue(w.reporter.cookie)).status).toBe(403);
    const m = await queue(w.mod.cookie);
    expect(m.body.items.map((i: { id: number }) => i.id)).toEqual([w.ids.game, w.ids.plain]);
    expect(m.body.nextCursor).toBeNull();
    const [game, person] = m.body.items;
    expect(person).toEqual({
      id: w.ids.plain,
      reporter: { publicId: w.reporter.publicId, nickname: 'Reporter', role: 'user' },
      targetUser: { publicId: w.plain.publicId, nickname: 'Plain', role: 'user' },
      targetGame: null,
      reason: 'harassment',
      message: 'Текст',
      status: 'new',
      resolvedBy: null,
      resolvedAt: null,
      sanctionId: null,
      createdAt: expect.any(String),
    });
    expect(game.targetUser).toBeNull();
    expect(game.targetGame).toEqual({ id: w.gameId, title: 'Гра' });
  });

  it('status filter and cursor pagination', async () => {
    const mod = await user('Mod', 'moderator');
    const rep = await user('Reporter');
    const t = await user('Target');
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedComplaint(rep.id, { userId: t.id }));
    const dismissed = await seedComplaint(rep.id, { userId: t.id }, 'dismissed');
    const p1 = await queue(mod.cookie, '?status=new&limit=3');
    expect(p1.body.items.map((i: { id: number }) => i.id)).toEqual([ids[4], ids[3], ids[2]]);
    expect(p1.body.nextCursor).toBe(ids[2]);
    const p2 = await queue(mod.cookie, `?status=new&limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: { id: number }) => i.id)).toEqual([ids[1], ids[0]]);
    expect(p2.body.nextCursor).toBeNull();
    const d = await queue(mod.cookie, '?status=dismissed');
    expect(d.body.items.map((i: { id: number }) => i.id)).toEqual([dismissed]);
    expect((await queue(mod.cookie)).body.items).toHaveLength(6);
    expect((await queue(mod.cookie, '?status=bogus')).status).toBe(400);
  });
});

describe('POST /api/admin/complaints/:id/dismiss | action', () => {
  async function setup() {
    const mod = await user('Mod', 'moderator');
    const reporter = await user('Reporter');
    const target = await user('Target');
    const id = await seedComplaint(reporter.id, { userId: target.id });
    return { mod, reporter, target, id };
  }
  const dismiss = (id: number, cookie: string, body: object = {}) =>
    call('post', `/api/admin/complaints/${id}/dismiss`, cookie, body);
  const action = (id: number, cookie: string, body: object) =>
    call('post', `/api/admin/complaints/${id}/action`, cookie, body);
  const sanction = { type: 'warning', duration: '7d', reason: 'Не ображайте інших.' };

  it('dismiss/action use the role from the DB, not the cached session', async () => {
    const { mod, id } = await setup();
    // Перший запит кешує сесію з роллю moderator; далі роль знято повз сервіс (без скидання кешу).
    expect((await queue(mod.cookie)).status).toBe(200);
    await db.update(users).set({ role: 'user' }).where(eq(users.id, mod.id));
    const d = await dismiss(id, mod.cookie);
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await action(id, mod.cookie, { sanction })).status).toBe(403);
    const [c] = await db.select().from(complaints).where(eq(complaints.id, id));
    expect(c!.status).toBe('new');
  });

  it('dismiss: status, resolver, log entry; complainant gets complaint.resolved without details', async () => {
    const { mod, reporter, target, id } = await setup();
    await db
      .insert(authIdentities)
      .values({ userId: reporter.id, provider: 'telegram', subject: '7001' });
    const r = await dismiss(id, mod.cookie, { note: '  Недостатньо доказів  ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id,
      status: 'dismissed',
      resolvedBy: { publicId: mod.publicId, nickname: 'Mod', role: 'moderator' },
      resolvedAt: expect.any(String),
      sanctionId: null,
    });
    const [row] = await db.select().from(complaints).where(eq(complaints.id, id));
    expect(row).toMatchObject({ status: 'dismissed', resolvedBy: mod.id });
    expect(row!.resolvedAt).toBeInstanceOf(Date);
    expect(await db.select().from(moderationLog)).toEqual([
      expect.objectContaining({
        actorId: mod.id,
        action: 'complaint.dismiss',
        targetType: 'complaint',
        targetId: id,
        reason: 'Недостатньо доказів',
      }),
    ]);
    const notes = await db.select().from(notifications);
    expect(notes).toEqual([
      expect.objectContaining({
        userId: reporter.id,
        type: 'complaint.resolved',
        category: 'moderation',
        payload: {},
      }),
    ]);
    // Telegram за замовчуванням увімкнено для категорії moderation.
    expect(await db.select().from(telegramOutbox)).toHaveLength(1);
    // Ціль нічого не отримує.
    expect(notes.some((n) => n.userId === target.id)).toBe(false);
    // Повторно — 409.
    const again = await dismiss(id, mod.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('COMPLAINT_RESOLVED');
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it('action: creates a sanction linked to the complaint, actioned, logged, complainant notified', async () => {
    const { mod, reporter, target, id } = await setup();
    const r = await action(id, mod.cookie, { sanction });
    expect(r.status).toBe(200);
    const [s] = await db.select().from(sanctions);
    expect(s).toMatchObject({
      userId: target.id,
      type: 'warning',
      reason: 'Не ображайте інших.',
      imposedBy: mod.id,
      complaintId: id,
    });
    expect(s!.endsAt!.getTime() - s!.startsAt.getTime()).toBe(7 * DAY);
    expect(r.body).toMatchObject({ id, status: 'actioned', sanctionId: s!.id });
    const log = await db.select().from(moderationLog).orderBy(moderationLog.id);
    expect(log.map((l) => [l.action, l.targetType, l.targetId])).toEqual([
      ['sanction.impose', 'user', target.id],
      ['complaint.action', 'complaint', id],
    ]);
    expect(log.every((l) => l.actorId === mod.id)).toBe(true);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'complaint.resolved'));
    expect(notes).toEqual([expect.objectContaining({ userId: reporter.id, payload: {} })]);
    const again = await action(id, mod.cookie, { sanction });
    expect(again.status).toBe(409);
    expect(await db.select().from(sanctions)).toHaveLength(1);
  });

  it('action on a game complaint sanctions the GM', async () => {
    const mod = await user('Mod', 'moderator');
    const gm = await user('Майстер');
    const reporter = await user('Reporter');
    const gameId = await fx.game(gm.id, { status: 'recruiting' });
    const id = await seedComplaint(reporter.id, { gameId });
    expect((await action(id, mod.cookie, { sanction })).status).toBe(200);
    expect((await db.select().from(sanctions))[0]!.userId).toBe(gm.id);
  });

  it('moderator cannot global_ban via a complaint; failed action leaves the complaint new', async () => {
    const { mod, id } = await setup();
    const r = await action(id, mod.cookie, {
      sanction: { type: 'global_ban', duration: 'permanent', reason: 'x' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await db.select().from(complaints))[0]!.status).toBe('new');
    expect(await db.select().from(sanctions)).toEqual([]);
    expect(await db.select().from(moderationLog)).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('complaints about staff: invisible ones → 404; owner may only dismiss complaints about the owner', async () => {
    const owner = await user('Owner', 'owner');
    const admin = await user('Admin', 'admin');
    const mod = await user('Mod', 'moderator');
    const rep = await user('Reporter');
    const aboutMod = await seedComplaint(rep.id, { userId: mod.id });
    const aboutOwner = await seedComplaint(rep.id, { userId: owner.id });
    // Модератор не бачить скарги на себе: ні черга, ні дії.
    expect((await dismiss(aboutMod, mod.cookie)).status).toBe(404);
    expect((await action(aboutMod, mod.cookie, { sanction })).status).toBe(404);
    expect((await dismiss(aboutOwner, admin.cookie)).status).toBe(404);
    // Адмін діє щодо модератора.
    expect((await action(aboutMod, admin.cookie, { sanction })).status).toBe(200);
    // Власник — лише відхилити скаргу на себе.
    const r = await action(aboutOwner, owner.cookie, { sanction });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await dismiss(aboutOwner, owner.cookie)).status).toBe(200);
    expect((await dismiss(999_999, owner.cookie)).status).toBe(404);
  });

  it('game complaints follow the GM role: moderator-GM cannot see/dismiss their own game; admin/owner games hidden from moderators', async () => {
    const owner = await user('Owner', 'owner');
    const admin = await user('Admin', 'admin');
    const mod = await user('Mod', 'moderator');
    const plainGm = await user('PlainGm');
    const rep = await user('Reporter');
    const ownGame = await seedComplaint(rep.id, { gameId: await fx.game(mod.id) });
    const adminGame = await seedComplaint(rep.id, { gameId: await fx.game(admin.id) });
    const ownerGame = await seedComplaint(rep.id, { gameId: await fx.game(owner.id) });
    const userGame = await seedComplaint(rep.id, { gameId: await fx.game(plainGm.id) });
    const ids = (body: { items: { id: number }[] }) => body.items.map((i) => i.id).sort();
    expect(ids((await queue(mod.cookie)).body)).toEqual([userGame]);
    expect(ids((await queue(admin.cookie)).body)).toEqual([ownGame, userGame].sort());
    expect(ids((await queue(owner.cookie)).body)).toEqual(
      [ownGame, adminGame, ownerGame, userGame].sort(),
    );
    expect((await dismiss(ownGame, mod.cookie)).status).toBe(404);
    expect((await action(adminGame, mod.cookie, { sanction })).status).toBe(404);
    expect((await dismiss(adminGame, admin.cookie)).status).toBe(404);
    expect((await dismiss(ownGame, admin.cookie)).status).toBe(200);
  });

  it('owner viewing complaints about themselves or their game does not see the reporter', async () => {
    const owner = await user('Owner', 'owner');
    const rep = await user('Reporter');
    const aboutOwner = await seedComplaint(rep.id, { userId: owner.id });
    const aboutGame = await seedComplaint(rep.id, { gameId: await fx.game(owner.id) });
    const other = await user('Other');
    const aboutOther = await seedComplaint(rep.id, { userId: other.id });
    const q = await queue(owner.cookie);
    const byId = new Map(
      (q.body.items as { id: number; reporter: unknown }[]).map((i) => [i.id, i.reporter]),
    );
    expect(byId.get(aboutOwner)).toBeNull();
    expect(byId.get(aboutGame)).toBeNull();
    expect(byId.get(aboutOther)).toMatchObject({ publicId: rep.publicId });
    const d = await dismiss(aboutOwner, owner.cookie);
    expect(d.status).toBe(200);
    expect(d.body.reporter).toBeNull();
  });

  it('anonymity: the target sees no complaint and no reporter anywhere', async () => {
    const { mod, reporter, target, id } = await setup();
    expect((await queue(target.cookie)).status).toBe(403);
    expect((await dismiss(id, target.cookie)).status).toBe(403);
    await action(id, mod.cookie, { sanction });
    const own = await call('get', '/api/me/notifications', target.cookie);
    expect(JSON.stringify(own.body)).not.toContain(reporter.publicId);
    expect(JSON.stringify(own.body)).not.toContain('Reporter');
    // Сповіщення скаржнику — без цілі й санкції.
    const mine = await call('get', '/api/me/notifications', reporter.cookie);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ type: 'complaint.resolved', params: {}, link: '/' }),
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(target.publicId);
  });

  it('validation: bad id → 400/404, bad sanction → 400, bad note → 400', async () => {
    const { mod, id } = await setup();
    expect((await dismiss(id, mod.cookie, { note: 'a'.repeat(2001) })).status).toBe(400);
    expect((await dismiss(id, mod.cookie, { extra: 1 })).status).toBe(400);
    expect((await action(id, mod.cookie, { sanction: { type: 'warning' } })).status).toBe(400);
    expect((await action(id, mod.cookie, {})).status).toBe(400);
    expect((await call('post', '/api/admin/complaints/abc/dismiss', mod.cookie, {})).status).toBe(
      404,
    );
  });
});
