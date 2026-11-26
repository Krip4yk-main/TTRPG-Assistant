import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  events,
  gameApplications,
  gameMembers,
  gameSessions,
  games,
  notes,
} from '../../src/db/schema/index.js';
import { listProfileGames } from '../../src/games/games.service.js';
import { gameBusyIntervals } from '../../src/calendar/game-busy.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame, login } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Понеділок 16:00 UTC (18:00/19:00 за Києвом — той самий день) через `weeks` тижнів від найближчого. */
function mondayKyiv(weeks = 0): string {
  const d = new Date(Date.now() + DAY);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  d.setUTCHours(16, 0, 0, 0);
  return new Date(d.getTime() + weeks * WEEK).toISOString();
}

const sessionsOf = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));

/** Запущений щотижневий кампейн (понеділки) з учасником; сесії матеріалізовано. */
async function runningCampaign(opts: { status?: 'recruiting' | 'started' } = {}) {
  const gm = await userWithAge(30);
  const member = await userWithAge(25);
  const id = await createGame(gm.cookie, { startsAt: mondayKyiv() }, true);
  if (opts.status !== 'recruiting') {
    const s = await call('post', `/api/games/${id}/start`, gm.cookie);
    expect(s.status).toBe(200);
  }
  await db.insert(gameMembers).values({ gameId: id, userId: member.id, joinedAt: new Date() });
  return { gm, member, id };
}

const pause = (id: number, cookie: string, body: object = { reason: 'vacation' }) =>
  call('post', `/api/games/${id}/pause`, cookie, body);
const resume = (id: number, cookie: string, body: object) =>
  call('post', `/api/games/${id}/resume`, cookie, body);

describe('pause', () => {
  it('pauses a running campaign: future scheduled sessions → cancelled (campaign_paused), the rest untouched', async () => {
    const { gm, id } = await runningCampaign();
    const before = await sessionsOf(id);
    expect(before.length).toBeGreaterThanOrEqual(3);
    // Минула незавершена, уже скасована майбутня й завершена сесії не змінюються.
    const [past] = await db
      .insert(gameSessions)
      .values({
        gameId: id,
        startsAt: new Date(Date.now() - 2 * DAY),
        durationMinutes: 240,
        origin: 'manual',
      })
      .$returningId();
    const [done] = await db
      .insert(gameSessions)
      .values({
        gameId: id,
        startsAt: new Date(Date.now() - 9 * DAY),
        durationMinutes: 240,
        origin: 'manual',
        status: 'done',
        doneAt: new Date(),
      })
      .$returningId();
    const manualCancel = before[1]!.id;
    await db
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: 'Майстер у відрядженні' })
      .where(eq(gameSessions.id, manualCancel));

    const res = await pause(id, gm.cookie, { reason: 'illness', note: 'До березня' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'paused',
      pausedAt: expect.any(String),
      pauseReason: 'illness',
      pauseNote: 'До березня',
      nextSessionAt: null,
    });

    const after = await sessionsOf(id);
    for (const s of after.filter((x) => x.startsAt > new Date())) {
      expect(s.status).toBe('cancelled');
      expect(s.cancelReason).toBe(
        s.id === manualCancel ? 'Майстер у відрядженні' : 'campaign_paused',
      );
    }
    expect(after.find((s) => s.id === past!.id)).toMatchObject({ status: 'scheduled' });
    expect(after.find((s) => s.id === done!.id)).toMatchObject({ status: 'done' });

    const evs = await db.select().from(events);
    expect(evs.find((e) => e.type === 'game.paused')).toMatchObject({
      userId: gm.id,
      entityId: id,
      payload: { from: 'started', to: 'paused', reason: 'illness', note: 'До березня' },
    });
    const autoCancelled = evs.filter((e) => e.type === 'session.cancelled');
    expect(autoCancelled.length).toBe(before.length - 1);
    for (const e of autoCancelled) {
      expect(e.payload).toMatchObject({ reason: 'campaign_paused', auto: true });
    }
  });

  it('pauses from recruiting too; repeated pause → 409; oneshot/draft → 409; bad body → 400', async () => {
    const { gm, id } = await runningCampaign({ status: 'recruiting' });
    expect((await pause(id, gm.cookie)).body.status).toBe('paused');
    const again = await pause(id, gm.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GAME_INVALID_TRANSITION');

    const oneshot = await createGame(
      gm.cookie,
      { kind: 'oneshot', recurrence: 'none', weekdays: [], startsAt: mondayKyiv(1) },
      true,
    );
    expect((await pause(oneshot, gm.cookie)).status).toBe(409);
    const draft = await createGame(gm.cookie, { startsAt: mondayKyiv(1) });
    expect((await pause(draft, gm.cookie)).status).toBe(409);

    const other = await createGame(gm.cookie, { startsAt: mondayKyiv(1) }, true);
    for (const body of [{}, { reason: 'bored' }, { reason: 'other', note: 'x'.repeat(301) }]) {
      const r = await pause(other, gm.cookie, body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION');
    }
  });

  it('only the GM: member, admin and owner (not GM of this game) → 403', async () => {
    const { gm, member, id } = await runningCampaign();
    expect((await pause(id, member.cookie)).status).toBe(403);
    for (const role of ['admin', 'moderator', 'owner'] as const) {
      const staff = await createUser(db, { role });
      const cookie = await login(staff.id);
      const r = await pause(id, cookie);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
    expect((await pause(id, gm.cookie)).status).toBe(200);
    const admin = await createUser(db, { role: 'admin' });
    const r = await resume(id, await login(admin.id), { startsAt: mondayKyiv(2), recruit: false });
    expect(r.status).toBe(403);
    const m = await resume(id, member.cookie, { startsAt: mondayKyiv(2), recruit: false });
    expect(m.status).toBe(403);
  });

  it('paused campaign can be finished or cancelled; rule cannot be changed (PATCH → 409 GAME_PAUSED)', async () => {
    const { gm, id } = await runningCampaign();
    await pause(id, gm.cookie);
    const patch = await call('patch', `/api/games/${id}`, gm.cookie, { startsAt: mondayKyiv(3) });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe('GAME_PAUSED');
    const title = await call('patch', `/api/games/${id}`, gm.cookie, { title: 'Нова назва' });
    expect(title.status).toBe(200);
    const sched = await call('put', `/api/games/${id}/schedule`, gm.cookie, {
      startsAt: mondayKyiv(3),
      recurrence: 'weekly',
      weekdays: [0],
    });
    expect(sched.status).toBe(409);
    const fin = await call('post', `/api/games/${id}/finish`, gm.cookie);
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('finished');

    const second = await runningCampaign();
    await pause(second.id, second.gm.cookie);
    expect(
      (await call('post', `/api/games/${second.id}/cancel`, second.gm.cookie)).body.status,
    ).toBe('cancelled');
  });
});

describe('resume', () => {
  it('past date or a day outside the rule → 400; not paused → 409', async () => {
    const { gm, id } = await runningCampaign();
    const early = await resume(id, gm.cookie, { startsAt: mondayKyiv(1), recruit: false });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('GAME_INVALID_TRANSITION');
    await pause(id, gm.cookie);

    const pastMonday = new Date(Date.parse(mondayKyiv()) - 2 * WEEK).toISOString();
    const past = await resume(id, gm.cookie, { startsAt: pastMonday, recruit: false });
    expect(past.status).toBe(400);
    expect(past.body.error).toEqual({
      code: 'VALIDATION',
      details: { reason: 'STARTS_AT_IN_PAST' },
    });

    const tuesday = new Date(Date.parse(mondayKyiv(1)) + DAY).toISOString();
    const wrongDay = await resume(id, gm.cookie, { startsAt: tuesday, recruit: false });
    expect(wrongDay.status).toBe(400);
    expect(wrongDay.body.error.code).toBe('VALIDATION');
    expect(JSON.stringify(wrongDay.body.error.details)).toContain('weekdays');

    const halfMinute = new Date(Date.parse(mondayKyiv(1)) + 30_000).toISOString();
    expect((await resume(id, gm.cookie, { startsAt: halfMinute, recruit: false })).status).toBe(
      400,
    );
    expect((await resume(id, gm.cookie, { startsAt: mondayKyiv(1) })).status).toBe(400);

    const [row] = await db.select().from(games).where(eq(games.id, id));
    expect(row!.status).toBe('paused');
  });

  it('resumes from the new date: sessions start at startsAt, no duplicates, paused-cancelled slots are replaced', async () => {
    const { gm, member, id } = await runningCampaign();
    const old = await sessionsOf(id);
    await pause(id, gm.cookie, { reason: 'study_work' });
    // Нотатка на скасованій паузою сесії — така сесія лишається (скасованою).
    const noted = old[old.length - 1]!;
    await db.insert(notes).values({
      scope: 'session_private',
      gameId: id,
      sessionId: noted.id,
      userId: member.id,
      body: 'нотатка',
    });

    // Перша сесія після паузи — рівно на слот, який скасувала пауза (другий понеділок).
    const startsAt = mondayKyiv(1);
    expect(old.some((s) => s.ruleStartsAt?.toISOString() === startsAt)).toBe(true);
    const res = await resume(id, gm.cookie, { startsAt, recruit: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'started',
      startsAt,
      showWhenFull: false,
      pausedAt: null,
      pauseReason: null,
      pauseNote: null,
      nextSessionAt: startsAt,
    });

    const after = await sessionsOf(id);
    const scheduled = after.filter((s) => s.status === 'scheduled');
    expect(scheduled[0]!.startsAt.toISOString()).toBe(startsAt);
    expect(scheduled.every((s) => s.startsAt.toISOString() >= startsAt)).toBe(true);
    const times = scheduled.map((s) => s.startsAt.getTime());
    expect(new Set(times).size).toBe(times.length);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBe(WEEK);
    // Скасовані паузою без нотаток — прибрано; з нотаткою — лишилась скасованою, без слоту.
    const pausedLeft = after.filter((s) => s.cancelReason === 'campaign_paused');
    expect(pausedLeft.map((s) => s.id)).toEqual([noted.id]);
    expect(pausedLeft[0]!.ruleStartsAt).toBeNull();

    const [ev] = await db.select().from(events).where(eq(events.type, 'game.resumed'));
    expect(ev).toMatchObject({
      userId: gm.id,
      entityId: id,
      payload: { from: 'paused', to: 'started', startsAt, recruit: false },
    });
  });

  it('resume from a recruiting pause → started (startedAt stamped); recruit → showWhenFull and visible in search', async () => {
    const { gm, id } = await runningCampaign({ status: 'recruiting' });
    await pause(id, gm.cookie);
    const res = await resume(id, gm.cookie, { startsAt: mondayKyiv(2), recruit: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'started',
      showWhenFull: true,
      startedAt: expect.any(String),
    });
    const search = await call('post', '/api/games/search', undefined, {});
    expect(search.body.items.map((g: { id: number }) => g.id)).toContain(id);
  });
});

describe('applications on a paused campaign', () => {
  it('apply → 409 GAME_PAUSED; pending stays pending; approve → 409 GAME_PAUSED; reject is allowed', async () => {
    const { gm, id } = await runningCampaign({ status: 'recruiting' });
    const a = await userWithAge(28);
    const b = await userWithAge(28);
    const late = await userWithAge(28);
    const body = { warningsAccepted: true, answers: [] };
    const appA = await call('post', `/api/games/${id}/applications`, a.cookie, body);
    const appB = await call('post', `/api/games/${id}/applications`, b.cookie, body);
    expect(appA.status).toBe(201);
    expect(appB.status).toBe(201);

    await pause(id, gm.cookie);
    const apply = await call('post', `/api/games/${id}/applications`, late.cookie, body);
    expect(apply.status).toBe(409);
    expect(apply.body.error.code).toBe('GAME_PAUSED');

    const pending = await db
      .select({ status: gameApplications.status })
      .from(gameApplications)
      .where(eq(gameApplications.gameId, id));
    expect(pending.map((p) => p.status)).toEqual(['pending', 'pending']);

    const approve = await call('post', `/api/applications/${appA.body.id}/approve`, gm.cookie);
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('GAME_PAUSED');
    const reject = await call('post', `/api/applications/${appB.body.id}/reject`, gm.cookie);
    expect(reject.status).toBe(200);

    // Після відновлення майстер вирішує заявку, що чекала.
    await resume(id, gm.cookie, { startsAt: mondayKyiv(2), recruit: false });
    const later = await call('post', `/api/applications/${appA.body.id}/approve`, gm.cookie);
    expect(later.status).toBe(200);
  });
});

describe('visibility of a paused campaign', () => {
  it('hidden from search and sitemap; page stays reachable', async () => {
    const { gm, id } = await runningCampaign({ status: 'recruiting' });
    const listed = await call('post', '/api/games/search', undefined, {});
    expect(listed.body.items.map((g: { id: number }) => g.id)).toContain(id);
    await pause(id, gm.cookie);
    await redis.flushdb();

    const search = await call('post', '/api/games/search', undefined, {});
    expect(search.body.items.map((g: { id: number }) => g.id)).not.toContain(id);
    const sitemap = await request(app).get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).not.toContain(`/games/${id}<`);
    const page = await call('get', `/api/games/${id}`);
    expect(page.status).toBe(200);
    expect(page.body.status).toBe('paused');
  });

  it('pause reason and note only for the GM and active members', async () => {
    const { gm, member, id } = await runningCampaign();
    const outsider = await userWithAge(30);
    const former = await userWithAge(30);
    await db.insert(gameMembers).values({
      gameId: id,
      userId: former.id,
      joinedAt: new Date(Date.now() - DAY),
      leftAt: new Date(),
      leftReason: 'left',
    });
    await pause(id, gm.cookie, { reason: 'other', note: 'Переїзд' });

    for (const cookie of [gm.cookie, member.cookie]) {
      const r = await call('get', `/api/games/${id}`, cookie);
      expect(r.body).toMatchObject({
        status: 'paused',
        pauseReason: 'other',
        pauseNote: 'Переїзд',
      });
    }
    for (const cookie of [outsider.cookie, former.cookie, undefined]) {
      const r = await call('get', `/api/games/${id}`, cookie);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('paused');
      expect(r.body.pausedAt).toEqual(expect.any(String));
      expect(r.body).not.toHaveProperty('pauseReason');
      expect(r.body).not.toHaveProperty('pauseNote');
    }
  });

  it('paused games stay in profile lists and «Мої ігри»; not in the calendar busy list', async () => {
    const { gm, member, id } = await runningCampaign();
    await pause(id, gm.cookie);
    const profile = await listProfileGames(deps, gm.id, null);
    expect(profile.asGm.map((g) => g.id)).toContain(id);
    const asPlayer = await listProfileGames(deps, member.id, null);
    expect(asPlayer.asPlayer.map((g) => g.id)).toContain(id);
    const mine = await call('get', '/api/games/mine', gm.cookie);
    expect(mine.body.find((g: { id: number }) => g.id === id)).toMatchObject({
      status: 'paused',
      nextSessionAt: null,
    });
    const scheduled = await db
      .select()
      .from(gameSessions)
      .where(and(eq(gameSessions.gameId, id), eq(gameSessions.status, 'scheduled')));
    expect(scheduled.filter((s) => s.startsAt > new Date())).toEqual([]);
    const to = new Date(Date.now() + 8 * WEEK);
    for (const u of [gm.id, member.id]) {
      expect(await gameBusyIntervals(deps, u, new Date(), to)).toEqual([]);
    }
  });
});
