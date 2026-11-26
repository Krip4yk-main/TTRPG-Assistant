import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  notificationLink,
  toZoned,
  zonedToUtc,
  type SessionAlternativesDto,
  type Weekday,
} from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  availabilitySlots,
  calendarReminders,
  games,
  gameSessions,
  notifications,
  rsvpDeclineNotices,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { runCalendarReminders } from '../../src/scheduling/calendar-reminder.service.js';
import {
  getSessionAlternatives,
  runRsvpDeclineNotices,
} from '../../src/scheduling/reschedule.service.js';
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
const KYIV = 'Europe/Kyiv';
const H = (h: number) => h * 60;
const LEAVE = { noteForGm: 'Переїжджаю в інше місто' };

type User = Awaited<ReturnType<typeof userWithAge>>;

function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), KYIV);
  const at = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, KYIV);
  return { iso: at.toISOString(), weekday: z.weekday };
}

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, {
    warningsAccepted: true,
    answers: [],
  });
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  const ok = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status} ${JSON.stringify(ok.body)}`);
}

const first = kyivAt(2);

/** Щотижнева кампанія з трьома учасниками; `sessionId` — перша сесія (через 2 доби). */
async function group(prefix = '', patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30, `${prefix}gm`);
  const a = await userWithAge(25, `${prefix}a`);
  const b = await userWithAge(25, `${prefix}b`);
  const c = await userWithAge(25, `${prefix}c`);
  const stranger = await userWithAge(25, `${prefix}s`);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.iso, weekdays: [first.weekday], ...patch },
    true,
  );
  for (const u of [a, b, c]) await join(gm, gameId, u);
  const [s] = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));
  return { gm, a, b, c, stranger, gameId, sessionId: s!.id, session: s! };
}

const rsvp = async (u: User, sessionId: number, status: 'going' | 'not_going') => {
  const res = await call('put', `/api/sessions/${sessionId}/rsvp`, u.cookie, { status });
  if (res.status !== 200) throw new Error(`rsvp ${res.status} ${JSON.stringify(res.body)}`);
};

/** Відсуває «не буду» учасника в минуле (замість очікування). */
const backdate = async (sessionId: number, u: User, ago: number) => {
  await db
    .update(rsvpDeclineNotices)
    .set({ declinedAt: new Date(Date.now() - ago) })
    .where(and(eq(rsvpDeclineNotices.sessionId, sessionId), eq(rsvpDeclineNotices.userId, u.id)));
};

const declinedFor = (userId: number) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'session.rsvp_declined')))
    .orderBy(asc(notifications.id));

describe('smart reschedule: «не буду» → GM notification', () => {
  it('waits the grace period, skips a member who flipped back, notifies once (repeat and parallel runs)', async () => {
    const { gm, a, b, gameId, sessionId, session } = await group();
    await rsvp(a, sessionId, 'not_going');
    // Ще в межах затримки — нічого.
    expect(await runRsvpDeclineNotices(deps, new Date())).toEqual([]);
    expect(await declinedFor(gm.id)).toHaveLength(0);

    await rsvp(b, sessionId, 'not_going');
    await rsvp(b, sessionId, 'going'); // передумав до доставки
    await backdate(sessionId, a, 10 * MIN);
    await backdate(sessionId, b, 10 * MIN);
    const now = new Date();
    const runs = await Promise.all([1, 2, 3].map(() => runRsvpDeclineNotices(deps, now)));
    expect(runs.flat()).toEqual([sessionId]);
    expect(await runRsvpDeclineNotices(deps, new Date(now.getTime() + 2 * HOUR))).toEqual([]);

    const rows = await declinedFor(gm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'schedule', entityType: 'session', entityId: sessionId });
    expect(rows[0]!.payload).toMatchObject({
      gameId,
      sessionId,
      startsAt: session.startsAt.toISOString(),
      actor: { publicId: a.publicId, nickname: 'a' },
      absentees: [{ publicId: a.publicId, nickname: 'a' }],
      count: 0,
    });
    expect(notificationLink('session.rsvp_declined', rows[0]!.payload)).toBe(
      `/games/${gameId}?session=${sessionId}`,
    );
    // Учасникам — нічого.
    expect(await declinedFor(a.id)).toHaveLength(0);
  });

  it('collapses several members of one session into one notification; MAX_WAIT bounds the wait', async () => {
    const { gm, a, b, c, sessionId } = await group();
    await rsvp(a, sessionId, 'not_going');
    await rsvp(b, sessionId, 'not_going');
    await backdate(sessionId, a, 10 * MIN);
    await backdate(sessionId, b, 2 * MIN); // b ще в затримці — чекаємо, щоб зібрати разом
    const now = Date.now();
    expect(await runRsvpDeclineNotices(deps, new Date(now))).toEqual([]);
    expect(await runRsvpDeclineNotices(deps, new Date(now + 4 * MIN))).toHaveLength(1);
    let rows = await declinedFor(gm.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.absentees?.map((x) => x.nickname)).toEqual(['a', 'b']);
    expect(rows[0]!.payload).toMatchObject({ actor: { nickname: 'a' }, count: 1 });

    // Свіже «не буду» когось іще не тримає готових вічно: через 30 хв від першого готового
    // сповіщення йде без тих, хто ще в затримці; вони — окремим, пізніше.
    await db.delete(notifications);
    await db.delete(rsvpDeclineNotices);
    await rsvp(c, sessionId, 'not_going');
    await backdate(sessionId, c, 31 * MIN);
    await rsvp(a, sessionId, 'going');
    await rsvp(a, sessionId, 'not_going'); // щойно — ще в затримці
    const t = Date.now();
    expect(await runRsvpDeclineNotices(deps, new Date(t))).toEqual([sessionId]);
    expect(await runRsvpDeclineNotices(deps, new Date(t + 6 * MIN))).toEqual([sessionId]);
    rows = await declinedFor(gm.id);
    expect(rows.map((r) => r.payload.absentees?.map((y) => y.nickname))).toEqual([['c'], ['a']]);
  });

  it('per member at most once per 30 min; repeated «не буду» does not restart the timer', async () => {
    const { gm, a, sessionId } = await group();
    await rsvp(a, sessionId, 'not_going');
    await backdate(sessionId, a, 10 * MIN);
    const t0 = Date.now();
    expect(await runRsvpDeclineNotices(deps, new Date(t0))).toEqual([sessionId]);

    // Повтор «не буду» (напр. кнопка в Telegram двічі) — без нового відліку.
    const [before] = await db.select().from(rsvpDeclineNotices);
    await rsvp(a, sessionId, 'not_going');
    const [same] = await db.select().from(rsvpDeclineNotices);
    expect(same!.declinedAt).toEqual(before!.declinedAt);
    expect(await runRsvpDeclineNotices(deps, new Date(t0 + HOUR))).toEqual([]);

    // «Буду» → «не буду» знову: нове сповіщення лише після паузи 30 хв від попереднього.
    await rsvp(a, sessionId, 'going');
    await rsvp(a, sessionId, 'not_going');
    expect(await runRsvpDeclineNotices(deps, new Date(t0 + 10 * MIN))).toEqual([]);
    expect(await runRsvpDeclineNotices(deps, new Date(t0 + 31 * MIN))).toEqual([sessionId]);
    expect(await declinedFor(gm.id)).toHaveLength(2);
  });

  it('category opt-out (site and Telegram), ex-members, rescheduled sessions', async () => {
    const { gm, a, b, gameId, sessionId } = await group();
    await db.insert(authIdentities).values({ userId: gm.id, provider: 'telegram', subject: '8801' });
    const prefs = (await call('get', '/api/me/notification-prefs', gm.cookie)).body;
    await call('put', '/api/me/notification-prefs', gm.cookie, {
      ...prefs,
      telegram: { ...prefs.telegram, schedule: false },
    });
    await db.delete(telegramOutbox);
    await rsvp(a, sessionId, 'not_going');
    await backdate(sessionId, a, 10 * MIN);
    await runRsvpDeclineNotices(deps, new Date());
    expect(await declinedFor(gm.id)).toHaveLength(1);
    expect(await db.select().from(telegramOutbox)).toHaveLength(0);

    // Вимкнено на сайті — не створюється взагалі.
    await call('put', '/api/me/notification-prefs', gm.cookie, {
      ...prefs,
      site: { schedule: false },
    });
    await db.delete(notifications);
    await rsvp(b, sessionId, 'not_going');
    await backdate(sessionId, b, 10 * MIN);
    expect(await runRsvpDeclineNotices(deps, new Date())).toEqual([]);
    expect(await declinedFor(gm.id)).toHaveLength(0);

    // Колишній учасник — не сповіщаємо.
    await call('put', '/api/me/notification-prefs', gm.cookie, prefs);
    const g2 = await group('x');
    await rsvp(g2.a, g2.sessionId, 'not_going');
    await backdate(g2.sessionId, g2.a, 10 * MIN);
    expect((await call('post', `/api/games/${g2.gameId}/leave`, g2.a.cookie, LEAVE)).status).toBe(
      204,
    );
    expect(await runRsvpDeclineNotices(deps, new Date())).toEqual([]);
    expect(await declinedFor(g2.gm.id)).toHaveLength(0);

    // Перенесення скидає RSVP — і стан підказки.
    await rsvp(g2.b, g2.sessionId, 'not_going');
    const moved = await call('post', `/api/sessions/${g2.sessionId}/reschedule`, g2.gm.cookie, {
      startsAt: kyivAt(3, 18).iso,
    });
    expect(moved.status).toBe(200);
    expect(
      await db
        .select()
        .from(rsvpDeclineNotices)
        .where(eq(rsvpDeclineNotices.sessionId, g2.sessionId)),
    ).toEqual([]);
    void gameId;
  });
});

describe('GET /api/sessions/:id/alternatives', () => {
  it('GM only: guest 401, member/stranger 403, unknown 404, cancelled 409', async () => {
    const { gm, a, stranger, sessionId } = await group();
    const url = `/api/sessions/${sessionId}/alternatives`;
    expect((await call('get', url)).status).toBe(401);
    const m = await call('get', url, a.cookie);
    expect(m.status).toBe(403);
    expect(m.body.error.code).toBe('FORBIDDEN');
    expect((await call('get', url, stranger.cookie)).status).toBe(403);
    expect((await call('get', '/api/sessions/999999/alternatives', gm.cookie)).status).toBe(404);
    const ok = await call('get', url, gm.cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.sessionId).toBe(sessionId);
    await call('post', `/api/sessions/${sessionId}/cancel`, gm.cookie, { reason: 'хворію' });
    const c = await call('get', url, gm.cookie);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('top 3 in the session week, without its current time and other sessions of the game', async () => {
    const { gm, a, gameId } = await group();
    // Лише наші сесії: середа через ~2 тижні (весь її тиждень — у майбутньому) і четвер.
    await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
    const base = new Date(Date.now() + 14 * DAY);
    const z0 = toZoned(base, KYIV);
    const wed = toZoned(new Date(base.getTime() + (2 - z0.weekday) * DAY), KYIV);
    const wedNoon = zonedToUtc({ year: wed.year, month: wed.month, day: wed.day, hour: 12, minute: 0 }, KYIV);
    /** `hour`:00 Kyiv через `dayOffset` діб від тієї середи. */
    const at = (dayOffset: number, hour: number) => {
      const z = toZoned(new Date(wedNoon.getTime() + dayOffset * DAY), KYIV);
      return zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, KYIV);
    };
    const [{ id: target }] = await db
      .insert(gameSessions)
      .values({ gameId, startsAt: at(0, 19), durationMinutes: 240, origin: 'manual' })
      .$returningId();
    // Інша сесія гри в четвер 19:00 — альтернатива з нею не перетинається.
    await db
      .insert(gameSessions)
      .values({ gameId, startsAt: at(1, 19), durationMinutes: 240, origin: 'manual' });
    const slots = (wd: Weekday, s: number, e: number) => ({ weekday: wd, startMin: s, endMin: e });
    for (const u of [gm, a]) {
      await db.insert(availabilitySlots).values(
        [slots(2, H(18), H(23) + 30), slots(3, H(19), H(23)), slots(4, H(10), H(20))].map((s) => ({
          userId: u.id,
          ...s,
        })),
      );
    }
    const res = await call('get', `/api/sessions/${target}/alternatives`, gm.cookie);
    expect(res.status).toBe(200);
    const dto = res.body as SessionAlternativesDto;
    expect(dto.from).toBe(at(-2, 0).toISOString()); // пн 00:00
    expect(dto.to).toBe(at(5, 0).toISOString()); // наступний пн 00:00
    expect(dto.startsAt).toBe(at(0, 19).toISOString());
    expect(dto.durationMinutes).toBe(240);
    expect(dto.alternatives.map((x) => x.startsAt)).toEqual([
      at(0, 18).toISOString(),
      at(2, 10).toISOString(),
      at(2, 14).toISOString(),
    ]);
    for (const alt of dto.alternatives) {
      expect(alt.can).toBe(2);
      expect(alt.statuses.map((s) => s.status)).toEqual(['can', 'can', 'unknown', 'unknown']);
    }
    expect(dto.participants.map((p) => p.userId)[0]).toBe(gm.id);

    // Тиждень, що вже почався: вікно — від «зараз».
    const now = new Date(at(0, 12).getTime());
    const mid = await getSessionAlternatives(deps, gm.id, target, now);
    expect(mid.from).toBe(now.toISOString());
    expect(mid.alternatives.map((x) => x.startsAt)).toEqual([
      at(0, 18).toISOString(),
      at(2, 10).toISOString(),
      at(2, 14).toISOString(),
    ]);
    const late = await getSessionAlternatives(deps, gm.id, target, at(2, 13));
    expect(late.alternatives.map((x) => x.startsAt)).toEqual([at(2, 13).toISOString()]);
    expect(late.alternatives.every((x) => Date.parse(x.startsAt) < Date.parse(late.to))).toBe(true);
  });
});

describe('empty-calendar reminder', () => {
  it('once, 24 h after joining, only for active campaign members without slots; opt-out respected', async () => {
    const { gm, a, b, c, gameId } = await group();
    const ex = await userWithAge(25, 'ex');
    await join(gm, gameId, ex);
    await db.insert(availabilitySlots).values({ userId: b.id, weekday: 0, startMin: 0, endMin: 600 });
    const prefs = (await call('get', '/api/me/notification-prefs', c.cookie)).body;
    await call('put', '/api/me/notification-prefs', c.cookie, { ...prefs, site: { schedule: false } });
    expect((await call('post', `/api/games/${gameId}/leave`, ex.cookie, LEAVE)).status).toBe(204);

    expect(await runCalendarReminders(deps, new Date())).toEqual([]);
    const now = Date.now() + 25 * HOUR;
    const runs = await Promise.all([1, 2].map(() => runCalendarReminders(deps, new Date(now))));
    expect(runs.flat()).toEqual([a.id]);
    expect(await runCalendarReminders(deps, new Date(now + 3 * DAY))).toEqual([]);

    const rows = await db.select().from(notifications).where(eq(notifications.type, 'calendar.empty'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a.id, category: 'schedule' });
    expect(rows[0]!.payload).toMatchObject({ gameId });
    expect(notificationLink('calendar.empty', rows[0]!.payload)).toBe('/calendar');
    // Вимкнений «Розклад» — позначено, щоб не надсилати й пізніше.
    const marks = (await db.select().from(calendarReminders)).map((r) => r.userId).sort();
    expect(marks).toEqual([a.id, c.id].sort((x, y) => x - y));

    // Слоти видалили, а календар уже нагадано — більше ніколи.
    await db.delete(availabilitySlots).where(eq(availabilitySlots.userId, b.id));
    expect(await runCalendarReminders(deps, new Date(now + 4 * DAY))).toEqual([b.id]);
    expect(await runCalendarReminders(deps, new Date(now + 5 * DAY))).toEqual([]);
  });

  it('existing members get it on the first run; ended campaigns and GMs do not', async () => {
    const { gm, a, gameId } = await group();
    const other = await group('o');
    await db.update(games).set({ status: 'finished' }).where(eq(games.id, other.gameId));
    const now = new Date(Date.now() + 30 * DAY);
    const sent = await runCalendarReminders(deps, now);
    expect(sent).toContain(a.id);
    expect(sent).not.toContain(gm.id);
    expect(sent).not.toContain(other.a.id);
    void gameId;
  });
});
