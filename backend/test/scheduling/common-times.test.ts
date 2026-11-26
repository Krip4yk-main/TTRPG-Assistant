import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { toZoned, zonedToUtc, type CommonTimesDto, type Weekday } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { availabilityBusyDates, availabilitySlots, users } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';
import {
  computeCommonTimes,
  getCommonTimes,
  loadGmGame,
} from '../../src/scheduling/common-times.service.js';

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
const KYIV = 'Europe/Kyiv';
const H = (h: number) => h * 60;

/** `hour`:00 Kyiv через `daysAhead` діб + день тижня. */
function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), KYIV);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, KYIV);
  return { startsAt: start.toISOString(), weekday: z.weekday, date: z };
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

async function slots(u: User, list: { weekday: Weekday; startMin: number; endMin: number }[]) {
  await db.insert(availabilitySlots).values(list.map((s) => ({ userId: u.id, ...s })));
}

const first = kyivAt(2);
const W = first.weekday;

/** Щотижнева кампанія (вт/ср/…: день першої сесії) о 19:00 Kyiv, 4 год, опублікована. */
async function campaign(gm: User, patch: Record<string, unknown> = {}) {
  return createGame(gm.cookie, { startsAt: first.startsAt, weekdays: [W], ...patch }, true);
}

const get = async (gameId: number, cookie: string, query = '') => {
  const res = await call('get', `/api/games/${gameId}/common-times${query}`, cookie);
  return res;
};

/**
 * Фіксоване «зараз»: північ (Kyiv) за добу до першої сесії — вікно не залежить від часу
 * запуску тестів (рівно 4 вівторки/середи/… у 4 тижнях).
 */
const NOW = zonedToUtc({ ...kyivAt(1).date, hour: 0, minute: 0 }, KYIV);
const ct = (gameId: number, gmId: number, query: Record<string, string> = {}) =>
  getCommonTimes(deps, gmId, gameId, query, NOW);

const find = (dto: CommonTimesDto, weekday: number, startMin: number) =>
  dto.regular.find((c) => c.weekday === weekday && c.startMin === startMin);

describe('GET /api/games/:id/common-times', () => {
  it('GM only: guest 401, stranger/member 403, unknown 404, draft for non-GM 404, bad query 400', async () => {
    const gm = await userWithAge(30, 'gm');
    const p = await userWithAge(25, 'p');
    const stranger = await userWithAge(25, 's');
    const id = await campaign(gm);
    await join(gm, id, p);
    expect((await call('get', `/api/games/${id}/common-times`)).status).toBe(401);
    const s = await get(id, stranger.cookie);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('FORBIDDEN');
    expect((await get(id, p.cookie)).status).toBe(403);
    expect((await get(999_999, gm.cookie)).status).toBe(404);
    const draft = await createGame(gm.cookie, { startsAt: first.startsAt, weekdays: [W] });
    expect((await get(draft, stranger.cookie)).status).toBe(404);
    expect((await get(draft, gm.cookie)).status).toBe(200);
    expect((await get(id, gm.cookie, '?weeks=9')).status).toBe(400);
    expect((await get(id, gm.cookie, '?weeks=2&weekOf=2027-01-04')).status).toBe(400);
    expect((await get(id, gm.cookie, '?weeks=2')).status).toBe(200);
  });

  it('converts a Warsaw member into the Kyiv game zone; own sessions do not block (RF 1)', async () => {
    const gm = await userWithAge(30, 'gm');
    const p = await userWithAge(25, 'warsaw');
    const empty = await userWithAge(25, 'empty');
    await db.update(users).set({ timezone: 'Europe/Warsaw' }).where(eq(users.id, p.id));
    const id = await campaign(gm);
    await join(gm, id, p);
    await join(gm, id, empty);
    await slots(gm, [{ weekday: W, startMin: H(19), endMin: H(23) }]);
    // 18:00–22:00 Warsaw = 19:00–23:00 Kyiv.
    await slots(p, [{ weekday: W, startMin: H(18), endMin: H(22) }]);

    expect((await get(id, gm.cookie)).status).toBe(200);
    const dto = await ct(id, gm.id);
    expect(dto.from).toBe(NOW.toISOString());
    expect(dto.noCalendars).toBe(false);
    expect(dto.timezone).toBe(KYIV);
    expect(dto.durationMinutes).toBe(240);
    expect(Date.parse(dto.to) - Date.parse(dto.from)).toBe(28 * DAY);
    expect(dto.participants).toEqual([
      { userId: gm.id, nickname: 'gm', isGm: true, hasCalendar: true },
      { userId: p.id, nickname: 'warsaw', isGm: false, hasCalendar: true },
      { userId: empty.id, nickname: 'empty', isGm: false, hasCalendar: false },
    ]);
    expect(dto.regular[0]).toMatchObject({
      weekday: W,
      startMin: H(19),
      weeks: 4,
      can: 2,
      cannot: 0,
      unknown: 1,
      statuses: [
        { userId: gm.id, status: 'can', weeksCan: 4 },
        { userId: p.id, status: 'can', weeksCan: 4 },
        { userId: empty.id, status: 'unknown', weeksCan: 0 },
      ],
    });
    expect(dto.oneOff[0]).toMatchObject({ startsAt: first.startsAt, can: 2, unknown: 1 });
    expect(dto.oneOff.every((c) => c.statuses[2]!.status === 'unknown')).toBe(true);
  });

  it('another game of a member and a busy date make them «cannot» (RF 5)', async () => {
    const gm = await userWithAge(30, 'gm');
    const otherGm = await userWithAge(30, 'other');
    const p = await userWithAge(25, 'p');
    const id = await campaign(gm);
    const other = await campaign(otherGm, { title: 'Інша гра' });
    await join(gm, id, p);
    await join(otherGm, other, p);
    const wide = [{ weekday: W, startMin: H(12), endMin: 1440 }];
    await slots(gm, wide);
    await slots(p, wide);

    const dto = await ct(id, gm.id);
    // 19:00 щотижня зайнято іншою грою → «не може»; 15:00 (до неї) — обидва можуть.
    const c19 = find(dto, W, H(19));
    if (c19) {
      expect(c19.statuses[1]).toEqual({
        userId: p.id,
        status: 'cannot',
        weeksCan: 0,
        outsideSlotsWeeks: 0,
      });
    }
    expect(dto.regular[0]).toMatchObject({ weekday: W, can: 2, cannot: 0 });
    expect(dto.regular[0]!.startMin + 240).toBeLessThanOrEqual(H(19));
    for (const c of dto.oneOff) {
      const local = toZoned(new Date(c.startsAt), KYIV);
      const startMin = local.hour * 60 + local.minute;
      // Перетин з 19:00–23:00 іншої гри → учасник «не може».
      if (startMin + 240 > H(19) && startMin < H(23)) {
        expect(c.statuses[1]!.status).toBe('cannot');
      }
    }

    // Зайнята дата першого тижня: регулярний кандидат лишається, але 3 з 4 тижнів.
    const d = first.date;
    const iso = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
    await db.insert(availabilityBusyDates).values({ userId: p.id, date: iso });
    const after = await ct(id, gm.id);
    expect(after.regular[0]!.statuses[1]).toEqual({
      userId: p.id,
      status: 'can',
      weeksCan: 3,
      outsideSlotsWeeks: 0,
    });
    expect(
      after.oneOff.some((c) => {
        const z = toZoned(new Date(c.startsAt), 'Europe/Kyiv');
        return z.day === d.day && z.month === d.month && c.statuses[1]!.status === 'can';
      }),
    ).toBe(false);
  });

  it('oneshot → only one-off candidates; paused campaign is allowed; weekOf narrows to a week', async () => {
    const gm = await userWithAge(30, 'gm');
    await slots(gm, [{ weekday: W, startMin: H(19), endMin: H(23) }]);
    const one = await createGame(
      gm.cookie,
      { kind: 'oneshot', recurrence: 'none', weekdays: [], startsAt: first.startsAt },
      true,
    );
    const o = await ct(one, gm.id);
    expect(o.regular).toEqual([]);
    expect(o.oneOff.length).toBeGreaterThan(0);

    const id = await campaign(gm);
    const paused = await call('post', `/api/games/${id}/pause`, gm.cookie, { reason: 'vacation' });
    expect(paused.status).toBe(200);
    const p = await get(id, gm.cookie);
    expect(p.status).toBe(200);

    const weekOf = kyivAt(14).date;
    const q = `${weekOf.year}-${String(weekOf.month).padStart(2, '0')}-${String(weekOf.day).padStart(2, '0')}`;
    const w = await ct(id, gm.id, { weekOf: q });
    expect(Date.parse(w.to) - Date.parse(w.from)).toBeLessThanOrEqual(7 * DAY + 3_600_000);
    const fromLocal = toZoned(new Date(w.from), KYIV);
    expect([fromLocal.weekday, fromLocal.hour, fromLocal.minute]).toEqual([0, 0, 0]);
    expect(w.oneOff).toHaveLength(1);
    expect(w.regular).toHaveLength(1);
    expect(w.regular[0]).toMatchObject({ weekday: W, startMin: H(19), weeks: 1 });
  });

  it('nobody has a calendar → empty lists and noCalendars', async () => {
    const gm = await userWithAge(30, 'gm');
    const p = await userWithAge(25, 'p');
    const id = await campaign(gm);
    await join(gm, id, p);
    const dto = await ct(id, gm.id);
    expect(dto.noCalendars).toBe(true);
    expect(dto.participants.every((x) => !x.hasCalendar)).toBe(true);
    expect(dto.regular).toEqual([]);
    expect(dto.oneOff).toEqual([]);
  });

  it('a candidate near the window end sees another game starting after the window', async () => {
    const gm = await userWithAge(30, 'gm');
    const otherGm = await userWithAge(30, 'other');
    const p = await userWithAge(25, 'p');
    const id = await campaign(gm, { startsAt: kyivAt(9).startsAt });
    // Інша гра — 19:00 Kyiv у день `first`; вікно закінчується о 18:00 того ж дня.
    const other = await campaign(otherGm, { title: 'Інша гра' });
    await join(otherGm, other, p);
    await join(gm, id, p);
    await slots(gm, [{ weekday: W, startMin: H(17) + 30, endMin: H(21) + 30 }]);
    await slots(p, [{ weekday: W, startMin: H(12), endMin: 1440 }]);
    const to = new Date(Date.parse(first.startsAt) - 3_600_000);
    const from = new Date(to.getTime() - 5 * 3_600_000);
    const game = await loadGmGame(deps, gm.id, id);
    const dto = await computeCommonTimes(deps, game, { from, to }, { now: NOW });
    // 17:30–21:30 перетинає 19:00 іншої гри, хоч та починається вже після `to`.
    const late = dto.oneOff.find(
      (c) => c.startsAt === new Date(to.getTime() - 1_800_000).toISOString(),
    );
    expect(late).toMatchObject({ can: 1, cannot: 1 });
    expect(late!.statuses[1]).toEqual({ userId: p.id, status: 'cannot' });
  });
});
