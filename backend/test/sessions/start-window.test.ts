import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc, type GameDto, type SessionDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  availabilitySlots,
  events,
  games,
  gameSessions,
  notifications,
} from '../../src/db/schema/index.js';
import { runDispatch } from '../../src/notifications/dispatcher.js';
import { sendReminders, sendUnpinnedReminders } from '../../src/notifications/reminders.js';
import { getSessionWindowSlots } from '../../src/sessions/start-window.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'Europe/Kyiv';

type User = Awaited<ReturnType<typeof userWithAge>>;

function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekday: z.weekday };
}

async function ok<T = unknown>(
  res: Promise<{ status: number; body: unknown }>,
  status = 200,
): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await ok<{ id: number }>(
    call('post', `/api/games/${gameId}/applications`, p.cookie, {
      warningsAccepted: true,
      answers: [],
    }),
    201,
  );
  await ok(call('post', `/api/applications/${a.id}/approve`, gm.cookie));
}

/** Щотижнева кампанія з вікном початку 19:00–21:00, перша сесія через 2 доби. */
async function windowed(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30, 'gm');
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday], startWindowMinutes: 120, ...patch },
    true,
  );
  return { gm, gameId, first };
}

const rows = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));

const notesOf = (userId: number, type: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)))
    .orderBy(asc(notifications.id));

/** Сесія гри напряму в БД (без правила). */
async function insertSession(
  gameId: number,
  startsAt: Date,
  patch: Partial<typeof gameSessions.$inferInsert> = {},
): Promise<number> {
  const [r] = await db
    .insert(gameSessions)
    .values({ gameId, startsAt, durationMinutes: 180, origin: 'manual', ...patch })
    .$returningId();
  return r!.id;
}

describe('approximate start time: game rule', () => {
  it('rule sessions inherit the game window; DTOs carry it', async () => {
    const { gm, gameId } = await windowed();
    const game = await ok<GameDto>(call('get', `/api/games/${gameId}`, gm.cookie));
    expect(game.startWindowMinutes).toBe(120);
    const r = await rows(gameId);
    expect(r).toHaveLength(4);
    expect(r.every((s) => s.startWindowMinutes === 120)).toBe(true);
    const list = await ok<SessionDto[]>(call('get', `/api/games/${gameId}/sessions`, gm.cookie));
    expect(list.map((s) => s.startWindowMinutes)).toEqual([120, 120, 120, 120]);
  });

  it('exact by default; window outside 30..720 / step 30 → 400', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    expect((await rows(id)).every((s) => s.startWindowMinutes === null)).toBe(true);
    for (const bad of [0, 45, 750]) {
      const res = await call('patch', `/api/games/${id}`, gm.cookie, { startWindowMinutes: bad });
      expect(res.status).toBe(400);
    }
  });

  it('changing the window updates future not-rescheduled rule sessions only', async () => {
    const { gm, gameId } = await windowed();
    const [s1, s2] = await rows(gameId);
    // Друга сесія перенесена (з точним часом) — нове вікно гри її не чіпає.
    await ok(
      call('post', `/api/sessions/${s2!.id}/reschedule`, gm.cookie, {
        startsAt: new Date(s2!.startsAt.getTime() + HOUR).toISOString(),
        startWindowMinutes: null,
      }),
    );
    await ok(call('patch', `/api/games/${gameId}`, gm.cookie, { startWindowMinutes: 60 }));
    const after = await rows(gameId);
    const moved = after.find((s) => s.id === s2!.id)!;
    expect(moved.startWindowMinutes).toBeNull();
    const rule = after.filter((s) => !s.rescheduled);
    expect(rule).toHaveLength(3);
    expect(rule.every((s) => s.startWindowMinutes === 60)).toBe(true);
    expect(rule[0]!.startsAt.getTime()).toBe(s1!.startsAt.getTime());
    // Вікно — поле правила: подія `game.rule_changed` зі знімком вікна.
    const [ev] = await db.select().from(events).where(eq(events.type, 'game.rule_changed'));
    expect(ev!.payload).toMatchObject({
      from: { startWindowMinutes: 120 },
      to: { startWindowMinutes: 60 },
    });
    // Прибрати вікно — точний час.
    await ok(call('patch', `/api/games/${gameId}`, gm.cookie, { startWindowMinutes: null }));
    expect(
      (await rows(gameId))
        .filter((s) => !s.rescheduled)
        .every((s) => s.startWindowMinutes === null),
    ).toBe(true);
  });

  it('PUT /schedule keeps the current window unless given', async () => {
    const { gm, gameId } = await windowed();
    const next = kyivAt(3);
    await ok(
      call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
        startsAt: next.startsAt,
        recurrence: 'weekly',
        weekdays: [next.weekday],
      }),
    );
    const scheduled = (await rows(gameId)).filter((s) => s.status === 'scheduled');
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((s) => s.startWindowMinutes === 120)).toBe(true);
    await ok(
      call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
        startsAt: next.startsAt,
        recurrence: 'weekly',
        weekdays: [next.weekday],
        startWindowMinutes: 30,
      }),
    );
    const g = await ok<GameDto>(call('get', `/api/games/${gameId}`, gm.cookie));
    expect(g.startWindowMinutes).toBe(30);
  });
});

describe('approximate start time: start / finish guards', () => {
  it('start → 409 SESSION_TIME_APPROXIMATE while the nearest session has a window', async () => {
    const { gm, gameId } = await windowed();
    const [s1] = await rows(gameId);
    const res = await call('post', `/api/games/${gameId}/start`, gm.cookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'SESSION_TIME_APPROXIMATE', details: { sessionId: s1!.id } },
    });
    const [g] = await db.select().from(games).where(eq(games.id, gameId));
    expect(g!.status).toBe('recruiting');
    // Уточнити час = перенесення на точний час без вікна.
    const pinned = await ok<SessionDto>(
      call('post', `/api/sessions/${s1!.id}/reschedule`, gm.cookie, {
        startsAt: new Date(s1!.startsAt.getTime() + 30 * MIN).toISOString(),
        startWindowMinutes: null,
      }),
    );
    expect(pinned.startWindowMinutes).toBeNull();
    // Наступні сесії ще з вікном — але найближча вже точна.
    await ok(call('post', `/api/games/${gameId}/start`, gm.cookie));
  });

  it('a past window still running counts as the nearest session', async () => {
    const { gm, gameId } = await windowed();
    const [s1] = await rows(gameId);
    // Вікно почалось годину тому й ще не скінчилось.
    await db
      .update(gameSessions)
      .set({ startsAt: new Date(Math.floor((Date.now() - HOUR) / MIN) * MIN) })
      .where(eq(gameSessions.id, s1!.id));
    const res = await call('post', `/api/games/${gameId}/start`, gm.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ sessionId: s1!.id });
  });

  it('finish of a windowed session → 409; after pinning it finishes', async () => {
    const { gm, gameId } = await windowed();
    const [s1] = await rows(gameId);
    const past = new Date(Math.floor((Date.now() - 3 * HOUR) / MIN) * MIN);
    await db.update(gameSessions).set({ startsAt: past }).where(eq(gameSessions.id, s1!.id));
    const body = { attendance: [], summary: null };
    const res = await call('post', `/api/sessions/${s1!.id}/finish`, gm.cookie, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_TIME_APPROXIMATE');
    // Уточнили (напряму в БД — минулий час перенесенням не задати).
    await db
      .update(gameSessions)
      .set({ startWindowMinutes: null })
      .where(eq(gameSessions.id, s1!.id));
    await ok(call('post', `/api/sessions/${s1!.id}/finish`, gm.cookie, body));
  });
});

describe('approximate start time: reschedule and notifications', () => {
  it('pin / window reschedule: event snapshot and member notification show window or exact time', async () => {
    const { gm, gameId } = await windowed();
    const p = await userWithAge(25, 'p');
    await join(gm, gameId, p);
    const [s1] = await rows(gameId);
    const exact = new Date(s1!.startsAt.getTime() + HOUR);
    await ok(
      call('post', `/api/sessions/${s1!.id}/reschedule`, gm.cookie, {
        startsAt: exact.toISOString(),
        startWindowMinutes: null,
      }),
    );
    await runDispatch(deps);
    const [pinnedNote] = await notesOf(p.id, 'session.rescheduled');
    expect(pinnedNote!.payload).toMatchObject({
      from: s1!.startsAt.toISOString(),
      fromWindowMinutes: 120,
      startsAt: exact.toISOString(),
    });
    expect(pinnedNote!.payload).not.toHaveProperty('startWindowMinutes');

    // Назад на вікно (без поля durationMinutes — лишається).
    const later = new Date(exact.getTime() + DAY);
    await ok(
      call('post', `/api/sessions/${s1!.id}/reschedule`, gm.cookie, {
        startsAt: later.toISOString(),
        startWindowMinutes: 90,
      }),
    );
    await runDispatch(deps);
    const notes = await notesOf(p.id, 'session.rescheduled');
    expect(notes[1]!.payload).toMatchObject({
      from: exact.toISOString(),
      startsAt: later.toISOString(),
      startWindowMinutes: 90,
    });
    expect(notes[1]!.payload).not.toHaveProperty('fromWindowMinutes');
    // Без поля — вікно лишається.
    const again = await ok<SessionDto>(
      call('post', `/api/sessions/${s1!.id}/reschedule`, gm.cookie, {
        startsAt: new Date(later.getTime() + HOUR).toISOString(),
      }),
    );
    expect(again.startWindowMinutes).toBe(90);
  });

  it('member reminders count from the window start and carry the window', async () => {
    const { gm, gameId } = await windowed();
    const [s1] = await rows(gameId);
    const created = await sendReminders(deps, new Date(s1!.startsAt.getTime() - 60 * MIN));
    expect(created.map((n) => n.userId)).toEqual([gm.id]);
    expect(created[0]!.payload).toMatchObject({
      startsAt: s1!.startsAt.toISOString(),
      startWindowMinutes: 120,
      offsetMin: 60,
    });
  });

  it('GM gets session.time_unpinned once, 24 h before the window; again after a reschedule', async () => {
    const gm = await userWithAge(30, 'gm');
    const gameId = await createGame(gm.cookie, {}, true);
    await db.update(games).set({ status: 'started' }).where(eq(games.id, gameId));
    await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
    const now = new Date(Math.floor(Date.now() / MIN) * MIN);
    const soon = await insertSession(gameId, new Date(now.getTime() + 10 * HOUR), {
      startWindowMinutes: 120,
    });
    // Далі ніж за добу, точна, скасована — без нагадування.
    await insertSession(gameId, new Date(now.getTime() + 30 * HOUR), { startWindowMinutes: 60 });
    await insertSession(gameId, new Date(now.getTime() + 5 * HOUR));
    await insertSession(gameId, new Date(now.getTime() + 6 * HOUR), {
      startWindowMinutes: 60,
      status: 'cancelled',
    });

    const runs = await Promise.all([1, 2, 3].map(() => sendUnpinnedReminders(deps, now)));
    expect(runs.flat()).toHaveLength(1);
    expect(await sendUnpinnedReminders(deps, new Date(now.getTime() + HOUR))).toHaveLength(0);
    const notes = await notesOf(gm.id, 'session.time_unpinned');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: 'sessions', entityType: 'session', entityId: soon });
    expect(notes[0]!.payload).toEqual({
      gameId,
      gameTitle: expect.any(String),
      sessionId: soon,
      startsAt: new Date(now.getTime() + 10 * HOUR).toISOString(),
      startWindowMinutes: 120,
    });

    // Перенесення на інше вікно — нове нагадування за новим часом.
    await ok(
      call('post', `/api/sessions/${soon}/reschedule`, gm.cookie, {
        startsAt: new Date(now.getTime() + 12 * HOUR).toISOString(),
      }),
    );
    expect(await sendUnpinnedReminders(deps, new Date())).toHaveLength(1);
    // Уточнений час — більше нічого.
    await ok(
      call('post', `/api/sessions/${soon}/reschedule`, gm.cookie, {
        startsAt: new Date(now.getTime() + 13 * HOUR).toISOString(),
        startWindowMinutes: null,
      }),
    );
    expect(await sendUnpinnedReminders(deps, new Date())).toHaveLength(0);
    expect(await notesOf(gm.id, 'session.time_unpinned')).toHaveLength(2);
  });
});

describe('GET /api/sessions/:id/window-slots', () => {
  it('GM only: every 30-min start in the window with who can / cannot', async () => {
    const gm = await userWithAge(30, 'gm');
    const a = await userWithAge(25, 'a');
    const b = await userWithAge(25, 'b');
    const stranger = await userWithAge(25, 's');
    const gameId = await createGame(gm.cookie, {}, true);
    for (const u of [a, b]) await join(gm, gameId, u);
    await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
    const day = kyivAt(3, 19);
    const start = new Date(day.startsAt);
    // 19:00–21:00 Kyiv, сесія 3 год.
    const sessionId = await insertSession(gameId, start, { startWindowMinutes: 120 });
    // a — може 19:00–23:30; b — 18:00–22:00 (лише старт о 19:00 вміщається).
    await db.insert(availabilitySlots).values([
      { userId: a.id, weekday: day.weekday, startMin: 19 * 60, endMin: 23 * 60 + 30 },
      { userId: b.id, weekday: day.weekday, startMin: 18 * 60, endMin: 22 * 60 },
    ]);

    expect((await call('get', `/api/sessions/${sessionId}/window-slots`, a.cookie)).status).toBe(
      403,
    );
    expect(
      (await call('get', `/api/sessions/${sessionId}/window-slots`, stranger.cookie)).status,
    ).toBe(403);
    const dto = await ok<{
      startWindowMinutes: number;
      participants: { userId: number }[];
      slots: {
        startsAt: string;
        can: number;
        cannot: number;
        unknown: number;
        statuses: { userId: number; status: string }[];
      }[];
    }>(call('get', `/api/sessions/${sessionId}/window-slots`, gm.cookie));
    expect(dto.startWindowMinutes).toBe(120);
    expect(dto.participants.map((p) => p.userId)).toEqual([gm.id, a.id, b.id]);
    expect(dto.slots.map((s) => s.startsAt)).toEqual(
      [0, 30, 60, 90, 120].map((m) => new Date(start.getTime() + m * MIN).toISOString()),
    );
    const statusOf = (i: number, u: User) =>
      dto.slots[i]!.statuses.find((s) => s.userId === u.id)!.status;
    // 19:00–22:00: обоє можуть; у майстра календаря немає — «невідомо».
    expect(dto.slots[0]).toMatchObject({ can: 2, cannot: 0, unknown: 1 });
    expect(statusOf(0, a)).toBe('can');
    expect(statusOf(0, b)).toBe('can');
    // 19:30–22:30: b уже не вміщається; a — до 20:30–23:30 включно.
    expect(statusOf(1, b)).toBe('cannot');
    expect(statusOf(3, a)).toBe('can');
    // 21:00–00:00 — поза слотом a (до 23:30).
    expect(statusOf(4, a)).toBe('cannot');
    expect(dto.slots[4]).toMatchObject({ can: 0, cannot: 2, unknown: 1 });
  });

  it('window across the spring DST switch: slots in UTC ms, end not shifted', async () => {
    const gm = await userWithAge(30, 'gm');
    const gameId = await createGame(gm.cookie, {}, true);
    await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
    // 28.03.2027 у Києві 03:00 EET → 04:00 EEST. Вікно 02:00 EET (00:00 UTC) + 180 хв.
    const start = zonedToUtc({ year: 2027, month: 3, day: 28, hour: 2, minute: 0 }, TZ);
    expect(start.toISOString()).toBe('2027-03-28T00:00:00.000Z');
    const sessionId = await insertSession(gameId, start, { startWindowMinutes: 180 });
    const dto = await getSessionWindowSlots(deps, gm.id, sessionId, new Date('2027-03-01T00:00Z'));
    expect(dto.slots).toHaveLength(7);
    expect(dto.slots.at(-1)!.startsAt).toBe('2027-03-28T03:00:00.000Z');
    // Останній старт — 06:00 за літнім часом (а не 05:00 «за годинником»).
    const last = toZoned(new Date(dto.slots.at(-1)!.startsAt), TZ);
    expect([last.hour, last.minute]).toEqual([6, 0]);
  });

  it('exact session → its single start; past starts are skipped; not scheduled → 409', async () => {
    const gm = await userWithAge(30, 'gm');
    const gameId = await createGame(gm.cookie, {}, true);
    await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
    const now = new Date(Math.floor(Date.now() / MIN) * MIN);
    const exact = await insertSession(gameId, new Date(now.getTime() + DAY));
    expect((await getSessionWindowSlots(deps, gm.id, exact, now)).slots).toHaveLength(1);
    const running = await insertSession(gameId, new Date(now.getTime() - 45 * MIN), {
      startWindowMinutes: 120,
    });
    const r = await getSessionWindowSlots(deps, gm.id, running, now);
    // −45, −15 — минули; +15, +45, +75.
    expect(r.slots).toHaveLength(3);
    const done = await insertSession(gameId, new Date(now.getTime() + DAY), { status: 'done' });
    expect((await call('get', `/api/sessions/${done}/window-slots`, gm.cookie)).status).toBe(409);
  });
});
