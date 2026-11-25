import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { notificationLink, type NotificationType } from '@nri/shared';
import {
  authIdentities,
  events,
  gameMembers,
  games,
  gameSessions,
  notificationPrefs,
  notifications,
  ratingReminderLog,
  ratings,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { logEvent } from '../../src/events/events.service.js';
import { registerJobs } from '../../src/jobs/index.js';
import { getHandler, getRecurring, resetRegistry } from '../../src/jobs/registry.js';
import { dispatchEvents } from '../../src/notifications/dispatcher.js';
import { ratingRole } from '../../src/ratings/ratings.eligibility.js';
import { RATING_DEADLINE_JOB, sendRatingDeadlines } from '../../src/ratings/ratings.reminders.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { at, DAY, ratingFixtures } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
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
const user = (nickname: string) => createUser(db, { nickname });

/** Оцінка/відмова напряму (поза API: час і вікна задаються фікстурами). */
async function rate(
  gameId: number,
  raterId: number,
  rateeId: number,
  sessionId: number | null,
  declined = false,
) {
  const [g] = await db.select({ gm: games.gmUserId }).from(games).where(eq(games.id, gameId));
  await db.insert(ratings).values({
    raterId,
    rateeId,
    gameId,
    sessionId,
    kind: sessionId === null ? 'final' : 'session',
    role: ratingRole(g!.gm, raterId, rateeId),
    declined,
    overall: declined ? null : 4,
  });
}

async function ratingNotes() {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.category, 'ratings'))
    .orderBy(notifications.userId, notifications.id);
  return rows;
}

const brief = (rows: Awaited<ReturnType<typeof ratingNotes>>) =>
  rows.map((r) => [r.userId, r.type as NotificationType]);

async function leave(gameId: number, userId: number, when: Date, reason = 'left' as const) {
  await db
    .update(gameMembers)
    .set({ leftAt: when, leftReason: reason })
    .where(and(eq(gameMembers.gameId, gameId), eq(gameMembers.userId, userId)));
}

describe('rating invitations from events', () => {
  it('session.done → only present participants who still have someone to rate', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const b = await user('Beta');
    const c = await user('Gamma');
    const gameId = await fx.game(gm.id);
    for (const u of [a, b, c]) await fx.member(gameId, u.id, ago(10));
    const doneAt = ago(0);
    const sessionId = await fx.done(gameId, doneAt, [a.id, b.id], [c.id]);
    // Alpha вже оцінила (і відмовилась оцінювати) усіх на сесії.
    await rate(gameId, a.id, gm.id, sessionId);
    await rate(gameId, a.id, b.id, sessionId, true);
    await logEvent(db, {
      type: 'session.done',
      userId: gm.id,
      entityType: 'session',
      entityId: sessionId,
      payload: { gameId, present: [a.id, b.id], absent: [c.id] },
    });
    await dispatchEvents(deps);
    const rows = await ratingNotes();
    expect(brief(rows)).toEqual([
      [gm.id, 'rating.session_open'],
      [b.id, 'rating.session_open'],
    ]);
    const closesAt = new Date(doneAt.getTime() + 14 * DAY).toISOString();
    expect(rows[0]!.payload).toEqual({ gameId, gameTitle: 'Гра', sessionId, closesAt });
    expect(notificationLink('rating.session_open', rows[0]!.payload)).toBe(
      `/games/${gameId}/rate?session=${sessionId}`,
    );
    // Повторна обробка тієї самої події нічого не дублює.
    await db.update(events).set({ dispatchedAt: null });
    await dispatchEvents(deps);
    expect(await ratingNotes()).toHaveLength(2);
  });

  it('leave → everyone who played with the leaver (not declined/rated) + the leaver; nobody else', async () => {
    const gm = await user('Майстер');
    const a = await user('Leaver');
    const b = await user('Beta');
    const c = await user('Absent');
    const e = await user('Decliner');
    const gameId = await fx.game(gm.id);
    for (const u of [a, b, c, e]) await fx.member(gameId, u.id, ago(10));
    await fx.done(gameId, ago(5), [a.id, b.id, e.id], [c.id]);
    // Приєднався після сесії — з Leaver не грав.
    const d = await user('Late');
    await fx.member(gameId, d.id, ago(1));
    await rate(gameId, e.id, a.id, null, true);
    await leave(gameId, a.id, at(Date.now() - 1000));
    await logEvent(db, {
      type: 'member.left',
      userId: a.id,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId },
    });
    await dispatchEvents(deps);
    const rows = await ratingNotes();
    expect(brief(rows)).toEqual([
      [gm.id, 'rating.member_left'],
      [a.id, 'rating.final_open'],
      [b.id, 'rating.member_left'],
    ]);
    const left = rows.find((r) => r.userId === b.id)!;
    // Поки гра йде — без дедлайну.
    expect(left.payload).toEqual({
      gameId,
      gameTitle: 'Гра',
      ratee: { publicId: a.publicId, nickname: 'Leaver' },
    });
    expect(notificationLink('rating.member_left', left.payload)).toBe(`/games/${gameId}/rate`);
    // Майстер отримує і `member.left` (members), і запрошення оцінити — з тієї самої події.
    const gmRows = await db.select().from(notifications).where(eq(notifications.userId, gm.id));
    expect(gmRows.map((r) => r.type).sort()).toEqual(['member.left', 'rating.member_left']);
    expect(new Set(gmRows.map((r) => r.eventId)).size).toBe(1);
  });

  it('kick → the GM (actor) is invited too; the kicked member gets both notifications', async () => {
    const gm = await user('Майстер');
    const a = await user('Kicked');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(10));
    await fx.done(gameId, ago(5), [a.id]);
    await leave(gameId, a.id, at(Date.now() - 1000));
    await logEvent(db, {
      type: 'member.kicked',
      userId: gm.id,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId, memberId: a.id },
    });
    await dispatchEvents(deps);
    expect(brief(await ratingNotes())).toEqual([
      [gm.id, 'rating.member_left'],
      [a.id, 'rating.final_open'],
    ]);
    const kicked = await db.select().from(notifications).where(eq(notifications.userId, a.id));
    expect(kicked.map((r) => r.type).sort()).toEqual(['member.kicked', 'rating.final_open']);
  });

  it('leave before any shared session / ban of a non-member → no rating notifications', async () => {
    const gm = await user('Майстер');
    const a = await user('Early');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(10));
    await leave(gameId, a.id, at(Date.now() - 1000));
    await logEvent(db, {
      type: 'member.left',
      userId: a.id,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId },
    });
    const x = await user('Stranger');
    await logEvent(db, {
      type: 'member.banned',
      userId: gm.id,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId, memberId: x.id, wasMember: false, cancelledApplicationIds: [] },
    });
    await dispatchEvents(deps);
    expect(await ratingNotes()).toEqual([]);
  });

  it('game.cancelled → leave pairs only: co-player and leaver invited, not someone who rated', async () => {
    const gm = await user('Майстер');
    const a = await user('Leaver');
    const b = await user('Stayed');
    const c = await user('RatedLeaver');
    const gameId = await fx.game(gm.id);
    for (const u of [a, b, c]) await fx.member(gameId, u.id, ago(20));
    await fx.done(gameId, ago(10), [a.id, b.id, c.id]);
    await leave(gameId, a.id, ago(5));
    await rate(gameId, gm.id, a.id, null);
    await rate(gameId, c.id, a.id, null);
    const cancelledAt = ago(0);
    await db.update(games).set({ status: 'cancelled', cancelledAt }).where(eq(games.id, gameId));
    await logEvent(db, {
      type: 'game.cancelled',
      userId: gm.id,
      entityType: 'game',
      entityId: gameId,
      payload: { from: 'started', to: 'cancelled' },
    });
    await dispatchEvents(deps);
    const rows = await ratingNotes();
    // Майстер і RatedLeaver уже оцінили того, хто вийшов; між тими, хто лишився, — пар немає.
    expect(brief(rows)).toEqual([
      [a.id, 'rating.final_open'],
      [b.id, 'rating.final_open'],
    ]);
    expect(rows[0]!.payload).toEqual({
      gameId,
      gameTitle: 'Гра',
      closesAt: new Date(cancelledAt.getTime() + 30 * DAY).toISOString(),
    });
  });

  it('leave right before dispatch (same second) is already seen — millisecond timestamps', async () => {
    const gm = await user('Майстер');
    const a = await user('Quick');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(10));
    await fx.done(gameId, ago(5), [a.id]);
    // Вихід «щойно»: зберігається з мілісекундами (без округлення до секунди «в майбутнє»).
    const leftAt = new Date();
    await leave(gameId, a.id, leftAt);
    const [m] = await db.select({ leftAt: gameMembers.leftAt }).from(gameMembers);
    expect(m!.leftAt!.getTime()).toBe(leftAt.getTime());
    await logEvent(db, {
      type: 'member.left',
      userId: a.id,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId },
    });
    await dispatchEvents(deps);
    expect(brief(await ratingNotes())).toEqual([
      [gm.id, 'rating.member_left'],
      [a.id, 'rating.final_open'],
    ]);
  });

  it('game.finished → everyone with open final targets, including former members', async () => {
    const gm = await user('Майстер');
    const a = await user('Former');
    const b = await user('RatedAll');
    const c = await user('NeverPlayed');
    const gameId = await fx.game(gm.id);
    for (const u of [a, b, c]) await fx.member(gameId, u.id, ago(20));
    await fx.done(gameId, ago(10), [a.id, b.id], [c.id]);
    await leave(gameId, a.id, ago(5));
    await rate(gameId, b.id, gm.id, null);
    await rate(gameId, b.id, a.id, null, true);
    const finishedAt = ago(0);
    await db.update(games).set({ status: 'finished', finishedAt }).where(eq(games.id, gameId));
    await logEvent(db, {
      type: 'game.finished',
      userId: gm.id,
      entityType: 'game',
      entityId: gameId,
      payload: { from: 'started', to: 'finished' },
    });
    await dispatchEvents(deps);
    const rows = await ratingNotes();
    expect(brief(rows)).toEqual([
      [gm.id, 'rating.final_open'],
      [a.id, 'rating.final_open'],
    ]);
    expect(rows[1]!.payload).toEqual({
      gameId,
      gameTitle: 'Гра',
      closesAt: new Date(finishedAt.getTime() + 30 * DAY).toISOString(),
    });
    // Учасники отримують і саме сповіщення про завершення (members/games — окремо).
    const bRows = await db.select().from(notifications).where(eq(notifications.userId, b.id));
    expect(bRows.map((r) => r.type)).toEqual(['game.finished']);
  });

  it('Telegram: ratings category off → no outbox row; legacy prefs without the key → default on', async () => {
    const gm = await user('Майстер');
    const a = await user('Off');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(10));
    const sessionId = await fx.done(gameId, ago(0), [a.id]);
    await db.insert(authIdentities).values([
      { userId: gm.id, provider: 'telegram', subject: '9001' },
      { userId: a.id, provider: 'telegram', subject: '9002' },
    ]);
    const legacy = {
      applications: true,
      members: true,
      sessions: true,
      reminders: true,
      games: true,
    };
    await db.insert(notificationPrefs).values([
      { userId: gm.id, telegram: legacy, reminderOffsets: [60] },
      { userId: a.id, telegram: { ...legacy, ratings: false }, reminderOffsets: [60] },
    ]);
    await logEvent(db, {
      type: 'session.done',
      userId: gm.id,
      entityType: 'session',
      entityId: sessionId,
      payload: { gameId, present: [a.id], absent: [] },
    });
    await dispatchEvents(deps);
    expect(brief(await ratingNotes())).toEqual([
      [gm.id, 'rating.session_open'],
      [a.id, 'rating.session_open'],
    ]);
    const out = await db.select().from(telegramOutbox);
    expect(out.map((o) => [o.userId, o.kind, o.buttons])).toEqual([
      [gm.id, 'rating.session_open', null],
    ]);
  });
});

describe('ratings.deadline', () => {
  it('is registered hourly and runs from job.runAt', () => {
    resetRegistry();
    registerJobs();
    expect(getRecurring(RATING_DEADLINE_JOB)).toEqual({ everyMs: 3_600_000 });
    expect(getHandler(RATING_DEADLINE_JOB)).toBeTypeOf('function');
    resetRegistry();
  });

  it('one reminder per (user, game, set) ≤ 48h before closing; rerun → no dupes; rated/declined → none', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const b = await user('Beta');
    const gameId = await fx.game(gm.id);
    for (const u of [a, b]) await fx.member(gameId, u.id, ago(20));
    // Закривається через добу — у вікні нагадування.
    const doneAt = ago(13);
    const closing = await fx.done(gameId, doneAt, [a.id, b.id]);
    // Закривається через 3 доби — ще рано.
    await fx.done(gameId, ago(11), [a.id, b.id]);
    // Beta: оцінила майстра й відмовилась оцінювати Alpha → нікого відкритого.
    await rate(gameId, b.id, gm.id, closing);
    await rate(gameId, b.id, a.id, closing, true);
    // Alpha оцінила лише майстра — Beta ще відкрита.
    await rate(gameId, a.id, gm.id, closing);

    const runAt = new Date();
    const first = await sendRatingDeadlines(deps, runAt);
    expect(first.map((r) => [r.userId, r.type]).sort()).toEqual(
      [
        [gm.id, 'rating.deadline'],
        [a.id, 'rating.deadline'],
      ].sort(),
    );
    const closesAt = new Date(doneAt.getTime() + 14 * DAY).toISOString();
    expect(first[0]!.payload).toEqual({
      gameId,
      gameTitle: 'Гра',
      sessionId: closing,
      // Дата сесії — для тексту нагадування (фікстура: початок за 4 год до завершення).
      startsAt: new Date(doneAt.getTime() - 4 * 3600_000).toISOString(),
      closesAt,
    });
    expect(first[0]!.category).toBe('ratings');
    expect(notificationLink('rating.deadline', first[0]!.payload)).toBe(
      `/games/${gameId}/rate?session=${closing}`,
    );
    // Повтор і наступні щогодинні слоти — без дублів.
    expect(await sendRatingDeadlines(deps, runAt)).toEqual([]);
    expect(await sendRatingDeadlines(deps, new Date(runAt.getTime() + 3_600_000))).toEqual([]);
    expect(await db.select().from(ratingReminderLog)).toHaveLength(2);
    expect(await ratingNotes()).toHaveLength(2);
  });

  it('window is taken from runAt: a slot 3 days earlier does not see a set closing tomorrow', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(20));
    await fx.done(gameId, ago(13), [a.id]);
    expect(await sendRatingDeadlines(deps, new Date(Date.now() - 3 * DAY))).toEqual([]);
    expect(await sendRatingDeadlines(deps, new Date())).toHaveLength(2);
  });

  it('a done session without done_at is reminded by its start time', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const gameId = await fx.game(gm.id);
    await fx.member(gameId, a.id, ago(20));
    // Початок — за 4 год до «завершення» 13 днів тому; вікно від початку закривається за ~1 день.
    const s = await fx.done(gameId, ago(13), [a.id]);
    await db.update(gameSessions).set({ doneAt: null }).where(eq(gameSessions.id, s));
    const rows = await sendRatingDeadlines(deps, new Date());
    expect(rows.map((r) => r.userId).sort()).toEqual([gm.id, a.id].sort());
    expect(rows[0]!.payload).toMatchObject({ sessionId: s });
  });

  it('final sets of finished games; a leave set while the game runs (no deadline) → none', async () => {
    const gm = await user('Майстер');
    const a = await user('Alpha');
    const finished = await fx.game(gm.id, { status: 'finished', finishedAt: ago(29) });
    await fx.member(finished, a.id, ago(40));
    await fx.done(finished, ago(35), [a.id]);
    await rate(finished, gm.id, a.id, null, true);

    const running = await fx.game(gm.id);
    const b = await user('Leaver');
    await fx.member(running, b.id, ago(40), ago(13));
    await fx.done(running, ago(20), [b.id]);

    const rows = await sendRatingDeadlines(deps, new Date());
    // Лише Alpha в завершеній грі; майстер відмовився; «вихідна» без дедлайну — нічого.
    expect(rows.map((r) => [r.userId, r.payload.gameId, r.payload.sessionId])).toEqual([
      [a.id, finished, undefined],
    ]);
    expect(rows[0]!.payload.closesAt).toBe(new Date(ago(29).getTime() + 30 * DAY).toISOString());
    expect(rows[0]!.entityType).toBe('game');
  });
});
