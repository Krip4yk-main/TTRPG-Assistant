import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc, type GameBusyDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { gameSessions } from '../../src/db/schema/index.js';
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

const sessionsOf = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));

/** Зайнятість на ~3 тижні вперед (у межах вікна матеріалізації). */
async function busy(cookie: string, days = 21): Promise<GameBusyDto[]> {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + days * DAY).toISOString();
  const res = await call(
    'get',
    `/api/me/calendar/game-busy?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    cookie,
  );
  if (res.status !== 200) throw new Error(`game-busy ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as GameBusyDto[];
}

describe('settings', () => {
  it('GET defaults to calendarAutoBusy=true; PATCH toggles; guest → 401', async () => {
    const u = await userWithAge(25);
    expect((await call('get', '/api/me/settings', u.cookie)).body).toEqual({
      calendarAutoBusy: true,
    });
    const p = await call('patch', '/api/me/settings', u.cookie, { calendarAutoBusy: false });
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ calendarAutoBusy: false });
    expect((await call('get', '/api/me/settings', u.cookie)).body).toEqual({
      calendarAutoBusy: false,
    });
    expect((await call('patch', '/api/me/settings', u.cookie, { x: 1 })).status).toBe(400);
    expect((await call('get', '/api/me/settings')).status).toBe(401);
  });
});

describe('GET /api/me/calendar/game-busy', () => {
  it('validates the range; guest → 401', async () => {
    const u = await userWithAge(25);
    expect((await call('get', '/api/me/calendar/game-busy', u.cookie)).status).toBe(400);
    const bad = await call(
      'get',
      '/api/me/calendar/game-busy?from=2026-12-02T00:00:00Z&to=2026-12-01T00:00:00Z',
      u.cookie,
    );
    expect(bad.status).toBe(400);
    expect(
      (
        await call(
          'get',
          '/api/me/calendar/game-busy?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z',
        )
      ).status,
    ).toBe(401);
  });

  it('appears after approval (player) and for the GM; stranger and applicant have none', async () => {
    const { gm, gameId, first } = await weekly();
    const p = await userWithAge(25);
    const stranger = await userWithAge(25);
    expect(await busy(p.cookie)).toEqual([]);
    const gmBusy = await busy(gm.cookie);
    expect(gmBusy).toHaveLength(3);
    const s = await sessionsOf(gameId);
    expect(gmBusy[0]).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      sessionId: s[0]!.id,
      start: first.startsAt,
      end: new Date(Date.parse(first.startsAt) + 240 * 60_000).toISOString(),
    } satisfies GameBusyDto);
    // Заявка без затвердження — ще не зайнято.
    await call('post', `/api/games/${gameId}/applications`, stranger.cookie, {
      warningsAccepted: true,
      answers: [],
    });
    expect(await busy(stranger.cookie)).toEqual([]);
    await join(gm, gameId, p);
    expect((await busy(p.cookie)).map((b) => b.sessionId)).toEqual(gmBusy.map((b) => b.sessionId));
  });

  it('includes sessions overlapping the range edges only', async () => {
    const { gm, first } = await weekly();
    const start = Date.parse(first.startsAt);
    const q = (from: number, to: number) =>
      call(
        'get',
        `/api/me/calendar/game-busy?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
        gm.cookie,
      );
    // Діапазон починається посеред сесії — сесію включено.
    expect((await q(start + 60 * 60_000, start + 2 * 3_600_000)).body).toHaveLength(1);
    // Діапазон закінчується рівно на початку сесії — не включено.
    expect((await q(start - 3_600_000, start)).body).toHaveLength(0);
    // Починається рівно в кінці сесії — не включено.
    expect((await q(start + 240 * 60_000, start + 300 * 60_000)).body).toHaveLength(0);
  });

  it('rule slots beyond the materialized window are included without sessionId', async () => {
    const { gm } = await weekly();
    const all = await busy(gm.cookie, 60);
    const materialized = all.filter((b) => b.sessionId !== null);
    const virtual = all.filter((b) => b.sessionId === null);
    expect(materialized).toHaveLength(4);
    expect(virtual.length).toBeGreaterThanOrEqual(3);
    expect(Date.parse(virtual[0]!.start)).toBeGreaterThan(Date.parse(materialized.at(-1)!.start));
  });

  it('disappears after leaving, kick and game cancellation', async () => {
    const { gm, gameId } = await weekly();
    const a = await userWithAge(25);
    const b = await userWithAge(25);
    await join(gm, gameId, a);
    await join(gm, gameId, b);
    expect(await busy(a.cookie)).toHaveLength(3);
    await call('post', `/api/games/${gameId}/leave`, a.cookie, { noteForGm: 'Не встигаю' });
    expect(await busy(a.cookie)).toEqual([]);
    await call('post', `/api/games/${gameId}/members/${b.publicId}/kick`, gm.cookie);
    expect(await busy(b.cookie)).toEqual([]);
    expect(await busy(gm.cookie)).toHaveLength(3);
    await call('post', `/api/games/${gameId}/cancel`, gm.cookie);
    expect(await busy(gm.cookie)).toEqual([]);
  });

  it('a cancelled session frees its time; a rescheduled one moves', async () => {
    const { gm, gameId } = await weekly();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const [s1, s2] = await sessionsOf(gameId);
    await call('post', `/api/sessions/${s1!.id}/cancel`, gm.cookie, { reason: 'хворію' });
    expect((await busy(p.cookie)).map((b) => b.sessionId)).not.toContain(s1!.id);
    const to = kyivAt(10, 12).startsAt;
    const r = await call('post', `/api/sessions/${s2!.id}/reschedule`, gm.cookie, {
      startsAt: to,
    });
    expect(r.status).toBe(200);
    const moved = (await busy(p.cookie)).find((b) => b.sessionId === s2!.id);
    expect(moved?.start).toBe(to);
  });

  it('autobusy off → empty; pinned game → present; unpinned → empty again', async () => {
    const { gm, gameId } = await weekly();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    await call('patch', '/api/me/settings', p.cookie, { calendarAutoBusy: false });
    expect(await busy(p.cookie)).toEqual([]);
    const pin = await call('post', `/api/me/calendar/pinned-games/${gameId}`, p.cookie);
    expect(pin.status).toBe(204);
    // Повторне закріплення — ідемпотентне.
    expect((await call('post', `/api/me/calendar/pinned-games/${gameId}`, p.cookie)).status).toBe(
      204,
    );
    expect(await busy(p.cookie)).toHaveLength(3);
    expect((await call('get', '/api/me/calendar/pinned-games', p.cookie)).body).toEqual({
      gameIds: [gameId],
    });
    const un = await call('delete', `/api/me/calendar/pinned-games/${gameId}`, p.cookie);
    expect(un.status).toBe(204);
    expect(await busy(p.cookie)).toEqual([]);
    // Закріплена гра, з якої вийшли, — більше не займає час.
    await call('post', `/api/me/calendar/pinned-games/${gameId}`, p.cookie);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'Не встигаю' });
    expect(await busy(p.cookie)).toEqual([]);
  });

  it('pinning: only the GM or an active member; unknown game → 404', async () => {
    const { gm, gameId } = await weekly();
    const stranger = await userWithAge(25);
    const s = await call('post', `/api/me/calendar/pinned-games/${gameId}`, stranger.cookie);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('NOT_A_MEMBER');
    expect((await call('post', `/api/me/calendar/pinned-games/${gameId}`, gm.cookie)).status).toBe(
      204,
    );
    expect((await call('post', '/api/me/calendar/pinned-games/999999', gm.cookie)).status).toBe(
      404,
    );
    expect((await call('post', `/api/me/calendar/pinned-games/${gameId}`)).status).toBe(401);
  });
});
