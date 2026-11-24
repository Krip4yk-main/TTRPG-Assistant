import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc, type SessionDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { events, games, gameSessions, sessionAttendance } from '../../src/db/schema/index.js';
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

const DAY = 86_400_000;
const TZ = 'Europe/Kyiv';

/** 19:00 Kyiv через `daysAhead` діб + його день тижня (0 — понеділок). */
function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekday: z.weekday };
}

type User = Awaited<ReturnType<typeof userWithAge>>;

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, {
    warningsAccepted: true,
    answers: [],
  });
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  const ok = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status} ${JSON.stringify(ok.body)}`);
}

/** Щотижнева кампанія з першою сесією через 2 доби, опублікована. */
async function weekly(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30);
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday], ...patch },
    true,
  );
  return { gm, gameId, first };
}

async function oneshot(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30);
  const gameId = await createGame(
    gm.cookie,
    { kind: 'oneshot', recurrence: 'none', weekdays: [], startsAt: kyivAt(3).startsAt, ...patch },
    true,
  );
  return { gm, gameId };
}

const rows = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));

const eventsOf = (type: string) => db.select().from(events).where(eq(events.type, type));

/** Переносить сесію в минуле напряму в БД (щоб її можна було завершити). */
async function moveToPast(sessionId: number) {
  await db
    .update(gameSessions)
    .set({ startsAt: new Date(Math.floor((Date.now() - 3 * 3_600_000) / 60_000) * 60_000) })
    .where(eq(gameSessions.id, sessionId));
}

describe('materialization on publish', () => {
  it('publishing a weekly game creates 4 sessions; GET does not duplicate', async () => {
    const { gm, gameId, first } = await weekly();
    const r = await rows(gameId);
    expect(r).toHaveLength(4);
    expect(r[0]!.startsAt.toISOString()).toBe(first.startsAt);
    const res = await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toEqual({
      id: r[0]!.id,
      gameId,
      startsAt: first.startsAt,
      durationMinutes: 240,
      status: 'scheduled',
      origin: 'rule',
      rescheduled: false,
      cancelReason: null,
      summary: null,
      doneAt: null,
    } satisfies SessionDto);
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    expect(await rows(gameId)).toHaveLength(4);
  });

  it('draft has no sessions; oneshot gets its single session at publish', async () => {
    const gm = await userWithAge(30);
    const draft = await createGame(gm.cookie, {
      startsAt: kyivAt(2).startsAt,
      weekdays: [],
      recurrence: 'none',
    });
    expect(await rows(draft)).toHaveLength(0);
    const { gameId } = await oneshot();
    expect(await rows(gameId)).toHaveLength(1);
  });
});

describe('GET /api/games/:id/sessions', () => {
  it('GM and active members — 200; strangers and former members — 403; guest — 401', async () => {
    const { gm, gameId } = await weekly();
    const p = await userWithAge(25);
    const stranger = await userWithAge(25);
    await join(gm, gameId, p);
    expect((await call('get', `/api/games/${gameId}/sessions`, p.cookie)).status).toBe(200);
    const s = await call('get', `/api/games/${gameId}/sessions`, stranger.cookie);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('NOT_A_MEMBER');
    expect((await call('get', `/api/games/${gameId}/sessions`)).status).toBe(401);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, {
      noteForGm: 'Не встигаю за розкладом',
    });
    expect((await call('get', `/api/games/${gameId}/sessions`, p.cookie)).status).toBe(403);
  });

  it("someone else's draft → 404", async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const draft = await createGame(gm.cookie);
    expect((await call('get', `/api/games/${draft}/sessions`, other.cookie)).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/reschedule', () => {
  it('GM moves a session; it stays moved after re-materialization; event', async () => {
    const { gm, gameId } = await weekly();
    const [s] = await rows(gameId);
    const to = kyivAt(4, 18).startsAt;
    const res = await call('post', `/api/sessions/${s!.id}/reschedule`, gm.cookie, {
      startsAt: to,
      durationMinutes: 180,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ startsAt: to, durationMinutes: 180, rescheduled: true });
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const after = await rows(gameId);
    expect(after).toHaveLength(4);
    expect(after.filter((r) => r.startsAt.toISOString() === s!.startsAt.toISOString())).toEqual([]);
    const ev = await eventsOf('session.rescheduled');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: gm.id, entityType: 'session', entityId: s!.id });
    expect(ev[0]!.payload).toMatchObject({ gameId, from: s!.startsAt.toISOString(), to });
  });

  it('a member cannot reschedule (403); a stranger — 403', async () => {
    const { gm, gameId } = await weekly();
    const p = await userWithAge(25);
    const stranger = await userWithAge(25);
    await join(gm, gameId, p);
    const [s] = await rows(gameId);
    const body = { startsAt: kyivAt(5).startsAt };
    expect((await call('post', `/api/sessions/${s!.id}/reschedule`, p.cookie, body)).status).toBe(
      403,
    );
    expect(
      (await call('post', `/api/sessions/${s!.id}/reschedule`, stranger.cookie, body)).status,
    ).toBe(403);
    expect((await call('post', `/api/sessions/999999/reschedule`, gm.cookie, body)).status).toBe(
      404,
    );
  });

  it('validation: past → 422, not a whole minute / bad duration → 400', async () => {
    const { gm, gameId } = await weekly();
    const [s] = await rows(gameId);
    const url = `/api/sessions/${s!.id}/reschedule`;
    const past = await call('post', url, gm.cookie, {
      startsAt: new Date(Math.floor((Date.now() - DAY) / 60_000) * 60_000).toISOString(),
    });
    expect(past.status).toBe(422);
    expect(past.body.error.code).toBe('GAME_IN_PAST');
    expect((await call('post', url, gm.cookie, { startsAt: '2030-01-01T10:00:30Z' })).status).toBe(
      400,
    );
    expect(
      (
        await call('post', url, gm.cookie, {
          startsAt: kyivAt(5).startsAt,
          durationMinutes: 45,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('post', url, gm.cookie, {
          startsAt: kyivAt(5).startsAt,
          durationMinutes: 750,
        })
      ).status,
    ).toBe(400);
  });
});

describe('POST /api/sessions/:id/cancel', () => {
  it('cancels with a reason; second cancel → 409; event', async () => {
    const { gm, gameId } = await weekly();
    const [s] = await rows(gameId);
    const url = `/api/sessions/${s!.id}/cancel`;
    expect((await call('post', url, gm.cookie, {})).status).toBe(400);
    const res = await call('post', url, gm.cookie, { reason: 'Майстер хворіє' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Майстер хворіє' });
    const again = await call('post', url, gm.cookie, { reason: 'ще раз' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SESSION_INVALID_STATE');
    // Скасовану не можна перенести.
    const r = await call('post', `/api/sessions/${s!.id}/reschedule`, gm.cookie, {
      startsAt: kyivAt(5).startsAt,
    });
    expect(r.status).toBe(409);
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    expect(await rows(gameId)).toHaveLength(4);
    const ev = await eventsOf('session.cancelled');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ gameId, reason: 'Майстер хворіє' });
  });
});

describe('POST /api/sessions/:id/finish', () => {
  it('records attendance and summary; done; event; members see the summary', async () => {
    const { gm, gameId } = await weekly();
    const p1 = await userWithAge(25);
    const p2 = await userWithAge(25);
    await join(gm, gameId, p1);
    await join(gm, gameId, p2);
    const [s] = await rows(gameId);
    await moveToPast(s!.id);
    const res = await call('post', `/api/sessions/${s!.id}/finish`, gm.cookie, {
      attendance: [
        { publicId: p1.publicId, present: true },
        { publicId: p2.publicId, present: false },
      ],
      summary: 'Герої дісталися замку',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'done', summary: 'Герої дісталися замку' });
    expect(res.body.doneAt).toEqual(expect.any(String));
    const att = await db
      .select()
      .from(sessionAttendance)
      .where(eq(sessionAttendance.sessionId, s!.id));
    expect(new Map(att.map((a) => [a.userId, a.present]))).toEqual(
      new Map([
        [p1.id, true],
        [p2.id, false],
      ]),
    );
    const list = await call('get', `/api/games/${gameId}/sessions`, p1.cookie);
    expect(list.body.find((x: SessionDto) => x.id === s!.id).summary).toBe('Герої дісталися замку');
    const ev = await eventsOf('session.done');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entityType: 'session', entityId: s!.id });
    const again = await call('post', `/api/sessions/${s!.id}/finish`, gm.cookie, {
      attendance: [],
    });
    expect(again.status).toBe(409);
  });

  it('unknown or former member in attendance → 400; future session → 409; member → 403', async () => {
    const { gm, gameId } = await weekly();
    const p = await userWithAge(25);
    const stranger = await userWithAge(25);
    await join(gm, gameId, p);
    const [s, s2] = await rows(gameId);
    await moveToPast(s!.id);
    const bad = await call('post', `/api/sessions/${s!.id}/finish`, gm.cookie, {
      attendance: [{ publicId: stranger.publicId, present: true }],
    });
    expect(bad.status).toBe(400);
    expect(
      (await call('post', `/api/sessions/${s!.id}/finish`, p.cookie, { attendance: [] })).status,
    ).toBe(403);
    const future = await call('post', `/api/sessions/${s2!.id}/finish`, gm.cookie, {
      attendance: [],
    });
    expect(future.status).toBe(409);
    expect(future.body.error.code).toBe('SESSION_INVALID_STATE');
    expect(await db.select().from(sessionAttendance)).toHaveLength(0);
  });
});

describe('PUT /api/games/:id/schedule (Review Focus 4)', () => {
  it('Tue → Thu: deletes future plain Tue sessions, keeps rescheduled and done, creates Thu', async () => {
    const gm = await userWithAge(30);
    // Найближчий вівторок (≥ 2 доби) і четвер після нього.
    let d = 2;
    while (kyivAt(d).weekday !== 1) d++;
    const tue = kyivAt(d);
    const thu = kyivAt(d + 2);
    const gameId = await createGame(gm.cookie, { startsAt: tue.startsAt, weekdays: [1] }, true);
    const before = await rows(gameId);
    expect(before.length).toBeGreaterThanOrEqual(3);
    const [t1, t2, t3] = before;
    const moved = kyivAt(d + 1, 20).startsAt;
    const rs = await call('post', `/api/sessions/${t1!.id}/reschedule`, gm.cookie, {
      startsAt: moved,
    });
    expect(rs.status).toBe(200);
    await db
      .update(gameSessions)
      .set({ status: 'done', doneAt: new Date() })
      .where(eq(gameSessions.id, t2!.id));
    await db
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: 'свято' })
      .where(eq(gameSessions.id, t3!.id));

    const res = await call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
      recurrence: 'weekly',
      weekdays: [3],
      startsAt: thu.startsAt,
      durationMinutes: 180,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recurrence: 'weekly',
      weekdays: [3],
      startsAt: thu.startsAt,
      durationMinutes: 180,
    });
    const after = await rows(gameId);
    const ids = new Set(after.map((r) => r.id));
    expect(ids.has(t1!.id) && ids.has(t2!.id) && ids.has(t3!.id)).toBe(true);
    const plain = after.filter((r) => ![t1!.id, t2!.id, t3!.id].includes(r.id));
    expect(plain.length).toBeGreaterThanOrEqual(3);
    for (const r of plain) {
      const z = toZoned(r.startsAt, TZ);
      expect([z.weekday, z.hour, r.durationMinutes, r.status]).toEqual([3, 19, 180, 'scheduled']);
    }
    expect(plain[0]!.startsAt.toISOString()).toBe(thu.startsAt);
    // Жодного неперенесеного вівторка не лишилось.
    expect(
      after.filter(
        (r) => !r.rescheduled && r.status === 'scheduled' && toZoned(r.startsAt, TZ).weekday === 1,
      ),
    ).toEqual([]);
    // Повторний GET нічого не дублює.
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    expect(await rows(gameId)).toHaveLength(after.length);
    const ev = await eventsOf('game.rule_changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: gm.id, entityType: 'game', entityId: gameId });
  });

  it('member → 403; oneshot → 409; invalid weekdays → 400; past startsAt → 422', async () => {
    const { gm, gameId, first } = await weekly();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const body = {
      recurrence: 'weekly',
      weekdays: [first.weekday],
      startsAt: first.startsAt,
      durationMinutes: 240,
    };
    expect((await call('put', `/api/games/${gameId}/schedule`, p.cookie, body)).status).toBe(403);
    const wrong = await call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
      ...body,
      weekdays: [(first.weekday + 1) % 7],
    });
    expect(wrong.status).toBe(400);
    const past = await call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
      ...body,
      startsAt: new Date(Math.floor((Date.now() - 7 * DAY) / 60_000) * 60_000).toISOString(),
      weekdays: [toZoned(new Date(Date.now() - 7 * DAY), TZ).weekday],
    });
    expect(past.status).toBe(422);
    const one = await oneshot();
    const o = await call('put', `/api/games/${one.gameId}/schedule`, one.gm.cookie, body);
    expect(o.status).toBe(409);
  });
});

describe('oneshot', () => {
  it('finishing the game marks its session done', async () => {
    const { gm, gameId } = await oneshot();
    await call('post', `/api/games/${gameId}/start`, gm.cookie);
    const f = await call('post', `/api/games/${gameId}/finish`, gm.cookie);
    expect(f.status).toBe(200);
    const [s] = await rows(gameId);
    expect(s).toMatchObject({ status: 'done' });
    expect(s!.doneAt).not.toBeNull();
    const ev = await eventsOf('session.done');
    expect(ev.map((e) => e.entityId)).toEqual([s!.id]);
  });

  it('PATCH of startsAt in recruiting moves the single session', async () => {
    const { gm, gameId } = await oneshot();
    const to = kyivAt(6).startsAt;
    const res = await call('patch', `/api/games/${gameId}`, gm.cookie, { startsAt: to });
    expect(res.status).toBe(200);
    const r = await rows(gameId);
    expect(r.map((x) => x.startsAt.toISOString())).toEqual([to]);
  });

  it('convert to campaign: allowed for oneshot (recruiting/started), campaign → 409', async () => {
    const { gm, gameId } = await oneshot();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const next = kyivAt(3);
    const body = { recurrence: 'weekly', weekdays: [next.weekday], startsAt: next.startsAt };
    expect(
      (await call('post', `/api/games/${gameId}/convert-to-campaign`, p.cookie, body)).status,
    ).toBe(403);
    expect(
      (
        await call('post', `/api/games/${gameId}/convert-to-campaign`, gm.cookie, {
          ...body,
          recurrence: 'none',
          weekdays: [],
        })
      ).status,
    ).toBe(400);
    const res = await call('post', `/api/games/${gameId}/convert-to-campaign`, gm.cookie, body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'campaign', recurrence: 'weekly' });
    const [g] = await db.select().from(games).where(eq(games.id, gameId));
    expect(g!.kind).toBe('campaign');
    expect(await rows(gameId)).toHaveLength(4);
    const ev = await eventsOf('game.converted_to_campaign');
    expect(ev).toHaveLength(1);
    const again = await call('post', `/api/games/${gameId}/convert-to-campaign`, gm.cookie, body);
    expect(again.status).toBe(409);

    // started ваншот теж можна перетворити; чернетку — ні.
    const s = await oneshot();
    await call('post', `/api/games/${s.gameId}/start`, s.gm.cookie);
    expect(
      (await call('post', `/api/games/${s.gameId}/convert-to-campaign`, s.gm.cookie, body)).status,
    ).toBe(200);
    const draft = await createGame(s.gm.cookie, {
      kind: 'oneshot',
      recurrence: 'none',
      weekdays: [],
    });
    expect(
      (await call('post', `/api/games/${draft}/convert-to-campaign`, s.gm.cookie, body)).status,
    ).toBe(409);
    // Поле kind і далі заблоковане в PATCH.
    const lock = await call('patch', `/api/games/${s.gameId}`, s.gm.cookie, { kind: 'oneshot' });
    expect(lock.status).toBe(409);
    expect(
      await db
        .select()
        .from(gameSessions)
        .where(and(eq(gameSessions.gameId, s.gameId), eq(gameSessions.status, 'scheduled'))),
    ).toHaveLength(4);
  });
});
