import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  gameMembers,
  gameSessions,
  games,
  gameSystems,
  genres,
  jobs,
  notificationPrefs,
  notifications,
  telegramOutbox,
  users,
} from '../../src/db/schema/index.js';
import { runDeadGamesDetector } from '../../src/games/dead-games/detector.js';
import {
  LONG_PAUSE_AT_UTC,
  LONG_PAUSE_JOB,
  runLongPauseReminders,
} from '../../src/games/dead-games/long-pause.js';
import { registerJobs } from '../../src/jobs/index.js';
import { getHandler, getRecurring, resetRegistry } from '../../src/jobs/registry.js';
import { dispatchEvents } from '../../src/notifications/dispatcher.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  resetRegistry();
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ago = (days: number, from = Date.now()) => new Date(from - days * DAY);

/** Понеділок 16:00 UTC через `weeks` тижнів від найближчого (день той самий і за Києвом). */
function mondayKyiv(weeks = 0): string {
  const d = new Date(Date.now() + DAY);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  d.setUTCHours(16, 0, 0, 0);
  return new Date(d.getTime() + weeks * WEEK).toISOString();
}

const notesOf = async (userId: number, type: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).filter(
    (n) => n.type === type,
  );
const outboxOf = async (userId: number, kind: string) =>
  (await db.select().from(telegramOutbox).where(eq(telegramOutbox.userId, userId))).filter(
    (r) => r.kind === kind,
  );
const row = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

async function linkTelegram(userId: number, tgId: string, games = true): Promise<void> {
  await db.insert(authIdentities).values({ userId, provider: 'telegram', subject: tgId });
  await db.insert(notificationPrefs).values({
    userId,
    telegram: {
      applications: true,
      members: true,
      sessions: true,
      reminders: true,
      games,
      ratings: true,
      moderation: true,
    },
    reminderOffsets: [60],
  });
}

/** Запущений щотижневий кампейн (понеділки) майстра `gm`. */
async function runningCampaign(cookie: string): Promise<number> {
  const id = await createGame(cookie, { startsAt: mondayKyiv() }, true);
  const s = await call('post', `/api/games/${id}/start`, cookie);
  expect(s.status).toBe(200);
  return id;
}

/** Гра напряму в БД (кампейн): опублікована `days` днів тому. */
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
      title: 'Кампейн на паузі',
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
      startedAt: ago(days),
      ...patch,
    })
    .$returningId();
  return r!.id;
}

const doneSession = (gameId: number, days: number) =>
  db.insert(gameSessions).values({
    gameId,
    startsAt: ago(days),
    durationMinutes: 240,
    origin: 'manual',
    status: 'done',
    doneAt: ago(days),
  });

describe('game.paused / game.resumed notifications (RF 4)', () => {
  it('active members get them (not the GM, not former members); params carry reason, note, date, recruit', async () => {
    const gm = await userWithAge(30, 'Майстер');
    const active = await userWithAge(25, 'Гравець');
    const former = await userWithAge(25, 'Колишній');
    const id = await runningCampaign(gm.cookie);
    await db.insert(gameMembers).values([
      { gameId: id, userId: active.id, joinedAt: new Date() },
      { gameId: id, userId: former.id, joinedAt: ago(20), leftAt: ago(1) },
    ]);
    await dispatchEvents(deps);

    const p = await call('post', `/api/games/${id}/pause`, gm.cookie, {
      reason: 'study_work',
      note: 'Сесія в універі',
    });
    expect(p.status).toBe(200);
    await dispatchEvents(deps);
    const [paused] = await notesOf(active.id, 'game.paused');
    expect(paused).toMatchObject({
      category: 'games',
      payload: {
        gameId: id,
        pauseReason: 'study_work',
        note: 'Сесія в універі',
        actor: { nickname: 'Майстер' },
      },
    });
    expect(await notesOf(gm.id, 'game.paused')).toHaveLength(0);
    expect(await notesOf(former.id, 'game.paused')).toHaveLength(0);
    // Скасування сесій паузою окремо не сповіщають.
    expect(await notesOf(active.id, 'session.cancelled')).toHaveLength(0);

    const startsAt = mondayKyiv(2);
    const r = await call('post', `/api/games/${id}/resume`, gm.cookie, { startsAt, recruit: true });
    expect(r.status).toBe(200);
    await dispatchEvents(deps);
    const [resumed] = await notesOf(active.id, 'game.resumed');
    expect(resumed).toMatchObject({ payload: { gameId: id, startsAt, recruit: true } });
    expect(await notesOf(gm.id, 'game.resumed')).toHaveLength(0);
    expect(await notesOf(former.id, 'game.resumed')).toHaveLength(0);
  });

  it('pause without a note → note null; resume without recruit → recruit false', async () => {
    const gm = await userWithAge(30);
    const member = await userWithAge(25);
    const id = await runningCampaign(gm.cookie);
    await db.insert(gameMembers).values({ gameId: id, userId: member.id, joinedAt: new Date() });
    await call('post', `/api/games/${id}/pause`, gm.cookie, { reason: 'vacation' });
    await call('post', `/api/games/${id}/resume`, gm.cookie, {
      startsAt: mondayKyiv(1),
      recruit: false,
    });
    await dispatchEvents(deps);
    expect((await notesOf(member.id, 'game.paused'))[0]!.payload).toMatchObject({
      pauseReason: 'vacation',
      note: null,
    });
    expect((await notesOf(member.id, 'game.resumed'))[0]!.payload).toMatchObject({
      recruit: false,
    });
  });

  it('Telegram follows the «games» setting and carries the recipient time zone', async () => {
    const gm = await userWithAge(30);
    const on = await userWithAge(25);
    const off = await userWithAge(25);
    await db.update(users).set({ timezone: 'America/New_York' }).where(eq(users.id, on.id));
    await linkTelegram(on.id, '9101');
    await linkTelegram(off.id, '9102', false);
    const id = await runningCampaign(gm.cookie);
    await db.insert(gameMembers).values([
      { gameId: id, userId: on.id, joinedAt: new Date() },
      { gameId: id, userId: off.id, joinedAt: new Date() },
    ]);
    await call('post', `/api/games/${id}/pause`, gm.cookie, { reason: 'illness' });
    await call('post', `/api/games/${id}/resume`, gm.cookie, {
      startsAt: mondayKyiv(1),
      recruit: false,
    });
    await dispatchEvents(deps);
    for (const kind of ['game.paused', 'game.resumed']) {
      // На сайті — обидва; у Telegram — лише з увімкненою категорією «ігри».
      expect(await notesOf(on.id, kind)).toHaveLength(1);
      expect(await notesOf(off.id, kind)).toHaveLength(1);
      const tg = await outboxOf(on.id, kind);
      expect(tg).toHaveLength(1);
      expect(tg[0]!.timeZone).toBe('America/New_York');
      expect(await outboxOf(off.id, kind)).toHaveLength(0);
    }
  });
});

describe('dead-games detector and pauses', () => {
  it('skips paused campaigns: no reminder, no dead mark, no notification', async () => {
    const gm = await createUser(db);
    const id = await insertGame(gm.id, 300, { status: 'paused', pausedAt: ago(200) });
    await doneSession(id, 250);
    const r = await runDeadGamesDetector(deps, new Date());
    expect(r).toMatchObject({ reminded: [], markedDead: [] });
    expect((await row(id)).deadAt).toBeNull();
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it('a resumed campaign is not stale right away: staleness counts from the resume', async () => {
    const gm = await createUser(db);
    const id = await insertGame(gm.id, 300, { resumedAt: ago(1) });
    await doneSession(id, 200);
    const r1 = await runDeadGamesDetector(deps, new Date());
    expect(r1).toMatchObject({ reminded: [], markedDead: [] });
    // Без проведених сесій після відновлення відлік іде як завжди: 31 день → нагадування.
    await db
      .update(games)
      .set({ resumedAt: ago(31) })
      .where(eq(games.id, id));
    const r2 = await runDeadGamesDetector(deps, new Date());
    expect(r2.reminded).toEqual([id]);
    expect(r2.markedDead).toEqual([]);
  });

  it('resume via the API stamps resumed_at; old done sessions do not make it stale', async () => {
    const gm = await userWithAge(30);
    const id = await runningCampaign(gm.cookie);
    await doneSession(id, 200);
    await db
      .update(games)
      .set({ publishedAt: ago(300) })
      .where(eq(games.id, id));
    await call('post', `/api/games/${id}/pause`, gm.cookie, { reason: 'other' });
    await db
      .update(games)
      .set({ pausedAt: ago(150) })
      .where(eq(games.id, id));
    const res = await call('post', `/api/games/${id}/resume`, gm.cookie, {
      startsAt: mondayKyiv(1),
      recruit: false,
    });
    expect(res.status).toBe(200);
    expect((await row(id)).resumedAt).not.toBeNull();
    const r = await runDeadGamesDetector(deps, new Date());
    expect(r).toMatchObject({ reminded: [], markedDead: [] });
    const mine = await call('get', '/api/games/mine', gm.cookie);
    const card = (mine.body as { id: number; staleness: string }[]).find((g) => g.id === id);
    expect(card).toMatchObject({ staleness: 'ok' });
  });
});

describe('long-pause reminder (game.long_pause)', () => {
  it('after 90 days paused: one reminder to the GM, repeated not earlier than 30 days later', async () => {
    const gm = await createUser(db);
    const member = await createUser(db);
    // Ціла секунда: DATETIME без дробових секунд округлює час (слот задачі — ціла хвилина).
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const id = await insertGame(gm.id, 300, { status: 'paused', pausedAt: ago(89, t0) });
    await db.insert(gameMembers).values({ gameId: id, userId: member.id, joinedAt: ago(200) });
    const at = (days: number) => new Date(t0 + days * DAY);

    expect(await runLongPauseReminders(deps, at(0))).toEqual([]);
    expect(await runLongPauseReminders(deps, at(2))).toEqual([id]);
    // Повтор того самого дня / перезапуск — без дубля; до 30 днів — нічого.
    expect(await runLongPauseReminders(deps, at(2))).toEqual([]);
    expect(await runLongPauseReminders(deps, at(31))).toEqual([]);
    expect(await notesOf(gm.id, 'game.long_pause')).toHaveLength(1);
    expect(await runLongPauseReminders(deps, at(32))).toEqual([id]);
    const notes = await notesOf(gm.id, 'game.long_pause');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      category: 'games',
      eventId: null,
      entityType: 'game',
      entityId: id,
      payload: { gameId: id, gameTitle: 'Кампейн на паузі' },
    });
    // Лише майстру.
    expect(await notesOf(member.id, 'game.long_pause')).toHaveLength(0);
  });

  it('not for running games; a stamp from an earlier pause does not count; inactive GM — no notification', async () => {
    const gm = await createUser(db);
    const running = await insertGame(gm.id, 300, {
      status: 'started',
      pausedAt: null,
      longPauseRemindedAt: null,
    });
    // Нагадування попередньої паузи (раніше за поточну `paused_at`) не блокує нове.
    const again = await insertGame(gm.id, 300, {
      status: 'paused',
      pausedAt: ago(95),
      longPauseRemindedAt: ago(100),
    });
    const banned = await createUser(db);
    await db.update(users).set({ isBanned: true }).where(eq(users.id, banned.id));
    const ofBanned = await insertGame(banned.id, 300, { status: 'paused', pausedAt: ago(120) });
    const done = await runLongPauseReminders(deps, new Date());
    expect(done.sort()).toEqual([again, ofBanned].sort());
    expect(done).not.toContain(running);
    expect(await notesOf(gm.id, 'game.long_pause')).toHaveLength(1);
    expect(await notesOf(banned.id, 'game.long_pause')).toHaveLength(0);
    // Позначку поставлено й для неактивного майстра — щодня не перевіряється заново.
    expect((await row(ofBanned)).longPauseRemindedAt).not.toBeNull();
  });

  it('Telegram follows the «games» setting', async () => {
    const on = await createUser(db);
    const off = await createUser(db);
    await linkTelegram(on.id, '9201');
    await linkTelegram(off.id, '9202', false);
    await insertGame(on.id, 300, { status: 'paused', pausedAt: ago(91) });
    await insertGame(off.id, 300, { status: 'paused', pausedAt: ago(91) });
    await runLongPauseReminders(deps, new Date());
    expect(await outboxOf(on.id, 'game.long_pause')).toHaveLength(1);
    expect(await notesOf(off.id, 'game.long_pause')).toHaveLength(1);
    expect(await outboxOf(off.id, 'game.long_pause')).toHaveLength(0);
  });

  it('registered as a daily job; the handler uses the job slot as «now»', async () => {
    resetRegistry();
    registerJobs();
    expect(getRecurring(LONG_PAUSE_JOB)).toEqual({ dailyAtUtc: LONG_PAUSE_AT_UTC });
    const gm = await createUser(db);
    await insertGame(gm.id, 300, { status: 'paused', pausedAt: ago(91) });
    const handler = getHandler(LONG_PAUSE_JOB)!;
    await handler(deps, null, { runAt: new Date() } as typeof jobs.$inferSelect);
    expect(await notesOf(gm.id, 'game.long_pause')).toHaveLength(1);
  });
});
