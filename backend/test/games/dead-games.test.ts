import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  gameMembers,
  gameSessions,
  gameStalenessLog,
  games,
  gameSystems,
  genres,
  jobs,
  moderationLog,
  notifications,
} from '../../src/db/schema/index.js';
import {
  DEAD_GAMES_AT_UTC,
  DEAD_GAMES_JOB,
  runDeadGamesDetector,
} from '../../src/games/dead-games/detector.js';
import { registerJobs } from '../../src/jobs/index.js';
import { getHandler, getRecurring, resetRegistry } from '../../src/jobs/registry.js';
import { runDispatch } from '../../src/notifications/dispatcher.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { login, call, validGame } = harness(deps, app);
const BASE = deps.env.PUBLIC_BASE_URL;

const DAY = 86_400_000;
const now = () => new Date();
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  resetRegistry();
  await redis.flushdb();
  await closeDeps(deps);
});

async function gmUser(patch: Parameters<typeof createUser>[1] = {}) {
  const u = await createUser(db, {
    nickname: `gm${Math.random().toString(36).slice(2, 8)}`,
    ...patch,
  });
  return { ...u, cookie: await login(u.id) };
}

/** Гра напряму в БД: за замовчуванням кампанія, опублікована й перша сесія `days` днів тому. */
async function insertGame(
  gmUserId: number,
  days: number,
  patch: Partial<typeof games.$inferInsert> = {},
): Promise<number> {
  const [s] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [g] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [r] = await db
    .insert(games)
    .values({
      gmUserId,
      title: 'Покинута кампанія',
      description: 'Опис',
      systemId: s!.id,
      genreId: g!.id,
      format: 'online',
      platform: 'Foundry',
      kind: 'campaign',
      startsAt: ago(days),
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [0],
      timezone: 'Europe/Kyiv',
      minPlayers: 1,
      maxPlayers: 5,
      status: 'started',
      publishedAt: ago(days),
      // Гра, що йде, видна в пошуку лише з show_when_full.
      showWhenFull: true,
      ...patch,
    })
    .$returningId();
  return r!.id;
}

async function insertSession(
  gameId: number,
  startsAt: Date,
  patch: Partial<typeof gameSessions.$inferInsert> = {},
): Promise<number> {
  const [r] = await db
    .insert(gameSessions)
    .values({ gameId, startsAt, durationMinutes: 240, origin: 'manual', ...patch })
    .$returningId();
  return r!.id;
}

const row = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;
const notesOf = async (userId: number, type?: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).filter(
    (n) => type === undefined || n.type === type,
  );

const searchIds = async (): Promise<number[]> => {
  const res = await call('post', '/api/games/search', undefined, {});
  expect(res.status).toBe(200);
  return (res.body.items as { id: number }[]).map((i) => i.id);
};

describe('detector: stale rule (RF 1)', () => {
  it('> 90 days without a done session → dead + one game.dead (no duplicates on rerun)', async () => {
    const gm = await gmUser();
    const id = await insertGame(gm.id, 100);
    const r1 = await runDeadGamesDetector(deps, now());
    expect(r1.markedDead).toEqual([id]);
    expect((await row(id)).deadAt).not.toBeNull();
    await runDeadGamesDetector(deps, now());
    await runDeadGamesDetector(deps, new Date(Date.now() + 3_600_000));
    const dead = await notesOf(gm.id, 'game.dead');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.category).toBe('games');
    expect(dead[0]!.payload).toEqual({ gameId: id, gameTitle: 'Покинута кампанія' });
    expect(await notesOf(gm.id, 'game.stale_reminder')).toHaveLength(0);
  });

  it('> 30 days → one reminder (no duplicates); 30 days or a future first session → nothing', async () => {
    const gm = await gmUser();
    const stale = await insertGame(gm.id, 40);
    const fresh = await insertGame(gm.id, 29);
    const future = await insertGame(gm.id, 0, {
      status: 'recruiting',
      publishedAt: ago(150),
      startsAt: ahead(30),
    });
    const r = await runDeadGamesDetector(deps, now());
    expect(r.reminded).toEqual([stale]);
    expect(r.markedDead).toEqual([]);
    await runDeadGamesDetector(deps, now());
    const reminders = await notesOf(gm.id, 'game.stale_reminder');
    expect(reminders.map((n) => n.entityId)).toEqual([stale]);
    for (const id of [fresh, future]) expect((await row(id)).deadAt).toBeNull();
  });

  it('campaign whose last done session was 89 days ago is not dead; a 91-day-old one is', async () => {
    const gm = await gmUser();
    const alive = await insertGame(gm.id, 300);
    await insertSession(alive, ago(89), { status: 'done', doneAt: ago(89) });
    const deadOne = await insertGame(gm.id, 300);
    await insertSession(deadOne, ago(91), { status: 'done', doneAt: ago(91) });
    // Заплановані сесії, що минули, не рахуються.
    await insertSession(deadOne, ago(7));
    const r = await runDeadGamesDetector(deps, now());
    expect(r.markedDead).toEqual([deadOne]);
    expect(r.reminded).toEqual([alive]);
  });

  it('first planned session counts as the anchor (published long ago, starts in 20 days → ok)', async () => {
    const gm = await gmUser();
    const id = await insertGame(gm.id, 0, {
      status: 'recruiting',
      publishedAt: ago(120),
      startsAt: ahead(20),
    });
    await insertSession(id, ahead(20));
    expect((await runDeadGamesDetector(deps, now())).markedDead).toEqual([]);
    expect(await notesOf(gm.id)).toHaveLength(0);
  });

  it('finished/cancelled/draft games are never checked', async () => {
    const gm = await gmUser();
    await insertGame(gm.id, 200, { status: 'finished' });
    await insertGame(gm.id, 200, { status: 'cancelled' });
    await insertGame(gm.id, 200, { status: 'draft', publishedAt: null });
    const r = await runDeadGamesDetector(deps, now());
    expect(r).toMatchObject({ markedDead: [], reminded: [] });
  });

  it('marks do not bump updated_at (not an «update» for viewers)', async () => {
    const gm = await gmUser();
    const id = await insertGame(gm.id, 100);
    const before = (await row(id)).updatedAt;
    await runDeadGamesDetector(deps, now());
    expect((await row(id)).updatedAt).toEqual(before);
  });
});

describe('«all ok» and admin exemption', () => {
  it('still-alive: clears dead, back in search; 14 days later dead again with a new notice', async () => {
    const gm = await gmUser();
    const id = await insertGame(gm.id, 100);
    await runDeadGamesDetector(deps, now());
    expect(await searchIds()).not.toContain(id);

    const res = await call('post', `/api/games/${id}/still-alive`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, state: 'ok', deadAt: null });
    const r = await row(id);
    expect(r.deadAt).toBeNull();
    const snooze = r.deadSnoozedUntil!.getTime() - Date.now();
    expect(snooze).toBeGreaterThan(13.9 * DAY);
    expect(snooze).toBeLessThanOrEqual(14 * DAY + 1000); // datetime округлюється до секунди
    expect(await searchIds()).toContain(id);

    // Протягом 14 днів — нічого.
    const r13 = await runDeadGamesDetector(deps, new Date(Date.now() + 13 * DAY));
    expect(r13.markedDead).toEqual([]);
    expect((await row(id)).deadAt).toBeNull();
    // Після 14 днів без проведених сесій — знову «мертва» й нове сповіщення.
    const r15 = await runDeadGamesDetector(deps, new Date(Date.now() + 15 * DAY));
    expect(r15.markedDead).toEqual([id]);
    expect(await notesOf(gm.id, 'game.dead')).toHaveLength(2);
  });

  it('still-alive / close-dead: only the GM (403 for others), finished game → 409', async () => {
    const gm = await gmUser();
    const other = await gmUser();
    const id = await insertGame(gm.id, 100);
    expect((await call('post', `/api/games/${id}/still-alive`, other.cookie)).status).toBe(403);
    expect((await call('post', `/api/games/${id}/close-dead`, other.cookie)).status).toBe(403);
    expect((await call('post', `/api/games/${id}/still-alive`)).status).toBe(401);
    const done = await insertGame(gm.id, 100, { status: 'finished' });
    const r = await call('post', `/api/games/${done}/still-alive`, gm.cookie);
    expect(r.status).toBe(409);
    expect((await call('post', `/api/games/${done}/close-dead`, gm.cookie)).status).toBe(409);
  });

  it('admin dismiss: exempt until the next done session', async () => {
    const gm = await gmUser();
    const mod = await gmUser({ role: 'moderator' });
    const id = await insertGame(gm.id, 100);
    const sessionId = await insertSession(id, ago(95));
    await runDeadGamesDetector(deps, now());
    const res = await call('post', `/api/admin/dead-games/${id}/dismiss`, mod.cookie, {
      kind: 'dead',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, deadAt: null });
    expect((await row(id)).deadExemptUntilSession).toBe(true);
    // Наступні прогони не повертають позначку (і не нагадують).
    await runDeadGamesDetector(deps, new Date(Date.now() + 60 * DAY));
    expect((await row(id)).deadAt).toBeNull();
    expect(await notesOf(gm.id, 'game.dead')).toHaveLength(1);
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({ actorId: mod.id, action: 'game.dismiss_dead', targetId: id });
    // Наступна проведена сесія знімає звільнення.
    const fin = await call('post', `/api/sessions/${sessionId}/finish`, gm.cookie, {
      attendance: [],
    });
    expect(fin.status).toBe(200);
    expect((await row(id)).deadExemptUntilSession).toBe(false);
    // Повторне зняття, коли позначки вже немає, — 409.
    const again = await call('post', `/api/admin/dead-games/${id}/dismiss`, mod.cookie, {
      kind: 'dead',
    });
    expect(again.status).toBe(409);
  });
});

describe('RF 2: marking a session done clears «dead» immediately', () => {
  it('finish session → dead_at cleared at once, back in search, creation unblocked', async () => {
    const gm = await gmUser();
    const id = await insertGame(gm.id, 100);
    const sessionId = await insertSession(id, ago(95));
    await runDeadGamesDetector(deps, now());
    expect((await row(id)).deadAt).not.toBeNull();
    const fin = await call('post', `/api/sessions/${sessionId}/finish`, gm.cookie, {
      attendance: [],
    });
    expect(fin.status).toBe(200);
    expect((await row(id)).deadAt).toBeNull();
    expect(await searchIds()).toContain(id);
    expect((await call('post', '/api/games', gm.cookie, await validGame())).status).toBe(201);
    // Наступний прогін не позначає знову (відлік — від проведеної сесії).
    expect((await runDeadGamesDetector(deps, now())).markedDead).toEqual([]);
  });
});

describe('RF 3: dead game hidden from lists, visible by link / to members / in GM history', () => {
  it('search, sitemap, OG, game page, member view, GM profile', async () => {
    const gm = await gmUser();
    const member = await gmUser();
    const dead = await insertGame(gm.id, 100);
    const alive = await insertGame(gm.id, 5);
    await db.insert(gameMembers).values({ gameId: dead, userId: member.id });
    await runDeadGamesDetector(deps, now());

    const ids = await searchIds();
    expect(ids).toContain(alive);
    expect(ids).not.toContain(dead);

    const sitemap = await request(app).get('/sitemap.xml');
    expect(sitemap.text).toContain(`<loc>${BASE}/games/${alive}</loc>`);
    expect(sitemap.text).not.toContain(`/games/${dead}<`);

    const og = await request(app).get(`/api/og/games/${dead}`);
    expect(og.text).toContain('<title>Покинута кампанія</title>');
    expect(og.text).toContain('<meta name="robots" content="noindex">');

    const guest = await call('get', `/api/games/${dead}`);
    expect(guest.status).toBe(200);
    expect(guest.body).toMatchObject({ id: dead, title: 'Покинута кампанія' });
    const asMember = await call('get', `/api/games/${dead}`, member.cookie);
    expect(asMember.status).toBe(200);
    expect(asMember.body.viewer.relation).toBe('member');
    expect(asMember.body.channelLinks).toBeDefined();

    const profile = await call('get', `/api/users/${gm.publicId}`);
    expect((profile.body.gamesAsGm as { id: number }[]).map((g) => g.id)).toContain(dead);
    const memberProfile = await call('get', `/api/users/${member.publicId}`);
    expect((memberProfile.body.gamesAsPlayer as { id: number }[]).map((g) => g.id)).toContain(dead);
  });
});

describe('overlap rule (suspicious)', () => {
  /** Дві активні ігри майстра з `n` перетинами сесій за останні 4 тижні. */
  async function overlapping(n: number) {
    const gm = await gmUser();
    const a = await insertGame(gm.id, 10, { title: 'А' });
    const b = await insertGame(gm.id, 10, { title: 'Б' });
    const sessions: number[] = [];
    for (let i = 0; i < n; i++) {
      const start = ago(2 + i * 7);
      await insertSession(a, start, { status: i === 0 ? 'done' : 'scheduled', doneAt: start });
      sessions.push(await insertSession(b, new Date(start.getTime() + 3_600_000)));
    }
    return { gm, a, b, sessions };
  }

  it('≥ 3 intersections in 4 weeks → both games suspicious, one notice each; 2 → none', async () => {
    const { gm, a, b } = await overlapping(3);
    const r = await runDeadGamesDetector(deps, now());
    expect(r.markedSuspicious.sort()).toEqual([a, b].sort());
    await runDeadGamesDetector(deps, now());
    const notes = await notesOf(gm.id, 'game.suspicious');
    expect(notes.map((n) => n.entityId).sort()).toEqual([a, b].sort());
    // Без прихування й блоку.
    expect(await searchIds()).toEqual(expect.arrayContaining([a, b]));
    expect((await call('post', '/api/games', gm.cookie, await validGame())).status).toBe(201);

    await resetDb(db);
    const two = await overlapping(2);
    expect((await runDeadGamesDetector(deps, now())).markedSuspicious).toEqual([]);
    expect(await notesOf(two.gm.id, 'game.suspicious')).toHaveLength(0);
  });

  it('cancelled and older-than-4-weeks sessions do not count; flag auto-clears', async () => {
    const { a, b, sessions } = await overlapping(3);
    await runDeadGamesDetector(deps, now());
    expect((await row(a)).suspiciousAt).not.toBeNull();
    await db
      .update(gameSessions)
      .set({ status: 'cancelled' })
      .where(eq(gameSessions.id, sessions[1]!));
    const r = await runDeadGamesDetector(deps, now());
    expect(r.unmarkedSuspicious.sort()).toEqual([a, b].sort());
    expect((await row(a)).suspiciousAt).toBeNull();
    // 4 тижні тому — уже поза вікном.
    await db
      .update(gameSessions)
      .set({ status: 'scheduled' })
      .where(eq(gameSessions.id, sessions[1]!));
    const later = await runDeadGamesDetector(deps, new Date(Date.now() + 14 * DAY));
    expect(later.markedSuspicious).toEqual([]);
  });

  it('admin dismiss: not re-flagged for 4 weeks', async () => {
    const { a } = await overlapping(3);
    const mod = await gmUser({ role: 'moderator' });
    await runDeadGamesDetector(deps, now());
    const list = await call('get', '/api/admin/dead-games?kind=suspicious', mod.cookie);
    expect(list.status).toBe(200);
    expect((list.body.items as { id: number }[]).map((g) => g.id)).toContain(a);
    const res = await call('post', `/api/admin/dead-games/${a}/dismiss`, mod.cookie, {
      kind: 'suspicious',
    });
    expect(res.status).toBe(200);
    const until = (await row(a)).suspiciousDismissedUntil!.getTime() - Date.now();
    expect(until).toBeGreaterThan(27.9 * DAY);
    expect(until).toBeLessThanOrEqual(28 * DAY + 1000);
    await runDeadGamesDetector(deps, now());
    expect((await row(a)).suspiciousAt).toBeNull();
    // Після строку — знову (перетини ще у вікні).
    await db
      .update(games)
      .set({ suspiciousDismissedUntil: ago(1) })
      .where(eq(games.id, a));
    expect((await runDeadGamesDetector(deps, now())).markedSuspicious).toEqual([a]);
  });
});

describe('creation block (GAME_CREATION_BLOCKED)', () => {
  it('409 with deadGameIds; /api/me/dead-games lists them; closing unblocks', async () => {
    const gm = await gmUser();
    const deadA = await insertGame(gm.id, 100, { status: 'recruiting' });
    const deadB = await insertGame(gm.id, 120);
    const stale = await insertGame(gm.id, 40);
    await runDeadGamesDetector(deps, now());

    const blocked = await call('post', '/api/games', gm.cookie, await validGame());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toEqual({
      code: 'GAME_CREATION_BLOCKED',
      details: { deadGameIds: [deadA, deadB] },
    });

    const mine = await call('get', '/api/me/dead-games', gm.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.deadGameIds).toEqual([deadA, deadB]);
    expect(
      (mine.body.items as { id: number; state: string }[]).map((i) => [i.id, i.state]),
    ).toEqual([
      [deadA, 'dead'],
      [deadB, 'dead'],
      [stale, 'stale'],
    ]);
    const my = await call('get', '/api/games/mine', gm.cookie);
    const byId = new Map((my.body as { id: number; staleness: string }[]).map((g) => [g.id, g]));
    expect(byId.get(deadA)).toMatchObject({ staleness: 'dead', suspicious: false });
    expect(byId.get(stale)).toMatchObject({ staleness: 'stale' });

    // Закриття за правилом: набір → скасована, що йде → завершена.
    const c1 = await call('post', `/api/games/${deadA}/close-dead`, gm.cookie);
    expect(c1.status).toBe(200);
    expect(c1.body.status).toBe('cancelled');
    const c2 = await call('post', `/api/games/${deadB}/close-dead`, gm.cookie);
    expect(c2.body.status).toBe('finished');
    expect(c2.body.closedByAdmin).toBe(false);
    expect((await row(deadB)).deadAt).toBeNull();
    expect((await call('post', '/api/games', gm.cookie, await validGame())).status).toBe(201);
    expect((await call('get', '/api/me/dead-games', gm.cookie)).body.deadGameIds).toEqual([]);
  });

  it('other GMs are not blocked; the block is lifted by «all ok»', async () => {
    const gm = await gmUser();
    const other = await gmUser();
    const id = await insertGame(gm.id, 100);
    await runDeadGamesDetector(deps, now());
    expect((await call('post', '/api/games', other.cookie, await validGame())).status).toBe(201);
    await call('post', `/api/games/${id}/still-alive`, gm.cookie);
    expect((await call('post', '/api/games', gm.cookie, await validGame())).status).toBe(201);
  });
});

describe('admin: dead games tab', () => {
  it('list/close need moderator+; moderator cannot act on a staff GM', async () => {
    const user = await gmUser();
    const mod = await gmUser({ role: 'moderator' });
    const adminGm = await gmUser({ role: 'admin' });
    const id = await insertGame(adminGm.id, 100);
    await runDeadGamesDetector(deps, now());
    expect((await call('get', '/api/admin/dead-games', user.cookie)).status).toBe(403);
    expect((await call('post', `/api/admin/dead-games/${id}/close`, user.cookie, {})).status).toBe(
      403,
    );
    const list = await call('get', '/api/admin/dead-games?kind=dead', mod.cookie);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id,
        status: 'started',
        gm: { publicId: adminGm.publicId, nickname: adminGm.nickname, role: 'admin' },
      }),
    ]);
    const res = await call('post', `/api/admin/dead-games/${id}/close`, mod.cookie, {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODERATION_FORBIDDEN');
  });

  it('close: recruiting → cancelled with closed_by_admin, log, GM notice; members get game.cancelled', async () => {
    const gm = await gmUser();
    const member = await gmUser();
    const mod = await gmUser({ role: 'moderator' });
    const id = await insertGame(gm.id, 100, { status: 'recruiting' });
    await db.insert(gameMembers).values({ gameId: id, userId: member.id });
    await runDeadGamesDetector(deps, now());

    const res = await call('post', `/api/admin/dead-games/${id}/close`, mod.cookie, {
      reason: 'покинута',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'cancelled', deadAt: null });
    const r = await row(id);
    expect(r).toMatchObject({ status: 'cancelled', closedByAdmin: true, deadAt: null });
    const view = await call('get', `/api/games/${id}`, member.cookie);
    expect(view.body.closedByAdmin).toBe(true);

    const logs = await db.select().from(moderationLog);
    expect(logs).toEqual([
      expect.objectContaining({
        actorId: mod.id,
        action: 'game.close',
        targetType: 'game',
        targetId: id,
        reason: 'покинута',
        meta: { from: 'recruiting', to: 'cancelled', dead: true, suspicious: false },
      }),
    ]);
    expect(await notesOf(gm.id, 'game.closed_by_admin')).toHaveLength(1);

    await runDispatch(deps);
    // Майстер не отримує ще й `game.cancelled`; учасник — так, без автора-модератора.
    expect(await notesOf(gm.id, 'game.cancelled')).toHaveLength(0);
    const [cancelled] = await notesOf(member.id, 'game.cancelled');
    expect(cancelled).toBeDefined();
    expect((cancelled!.payload as { actor?: unknown }).actor).toBeNull();

    // Уже закрита — 409.
    const again = await call('post', `/api/admin/dead-games/${id}/close`, mod.cookie, {});
    expect(again.status).toBe(409);
  });

  it('close a started (suspicious) game → finished; unflagged game → 409', async () => {
    const gm = await gmUser();
    const admin = await gmUser({ role: 'admin' });
    const id = await insertGame(gm.id, 10);
    await db.update(games).set({ suspiciousAt: now() }).where(eq(games.id, id));
    const res = await call('post', `/api/admin/dead-games/${id}/close`, admin.cookie, {});
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({
      status: 'finished',
      closedByAdmin: true,
      suspiciousAt: null,
    });
    const clean = await insertGame(gm.id, 10);
    const r = await call('post', `/api/admin/dead-games/${clean}/close`, admin.cookie, {});
    expect(r.status).toBe(409);
    expect(
      (await call('post', `/api/admin/dead-games/999999/close`, admin.cookie, {})).status,
    ).toBe(404);
  });
});

describe('job registration', () => {
  it('daily at 04:00 UTC; handler uses job.runAt; staleness log dedups per period', async () => {
    resetRegistry();
    registerJobs();
    expect(getRecurring(DEAD_GAMES_JOB)).toEqual({ dailyAtUtc: DEAD_GAMES_AT_UTC });
    expect(DEAD_GAMES_AT_UTC).toBe('04:00');
    const gm = await gmUser();
    const id = await insertGame(gm.id, 50);
    const handler = getHandler(DEAD_GAMES_JOB)!;
    // Слот 50 днів тому: гра ще свіжа — нічого.
    await handler(deps, null, { runAt: ago(45) } as typeof jobs.$inferSelect);
    expect(await notesOf(gm.id)).toHaveLength(0);
    await handler(deps, null, { runAt: now() } as typeof jobs.$inferSelect);
    expect(await notesOf(gm.id, 'game.stale_reminder')).toHaveLength(1);
    const log = await db
      .select()
      .from(gameStalenessLog)
      .where(and(eq(gameStalenessLog.gameId, id), eq(gameStalenessLog.kind, 'stale_reminder')));
    expect(log).toHaveLength(1);
  });
});
