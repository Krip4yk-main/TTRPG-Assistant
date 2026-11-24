import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { toZoned, zonedToUtc } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  availabilitySlots,
  contentWarnings,
  gameContentWarnings,
  gameMembers,
  games,
  gameSystems,
  genres,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY_MS = 86_400_000;
const KYIV = 'Europe/Kyiv';

/** Найближчий день тижня `weekday` (0 = пн) не раніше ніж за 2 доби, о `hour`:00 за Києвом. */
function nextKyiv(weekday: number, hour: number): Date {
  for (let i = 2; i < 10; i++) {
    const z = toZoned(new Date(Date.now() + i * DAY_MS), KYIV);
    if (z.weekday === weekday) {
      return zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, KYIV);
    }
  }
  throw new Error('unreachable');
}

async function catalog() {
  const s = await db.select({ id: gameSystems.id }).from(gameSystems).limit(2);
  const g = await db.select({ id: genres.id }).from(genres).limit(2);
  const w = await db.select({ id: contentWarnings.id }).from(contentWarnings).limit(2);
  return { systems: s.map((x) => x.id), genres: g.map((x) => x.id), warnings: w.map((x) => x.id) };
}

let gmId = 0;
async function gm(): Promise<number> {
  if (!gmId) gmId = (await createUser(db, { nickname: 'Gm' })).id;
  return gmId;
}
beforeEach(() => {
  gmId = 0;
});

/** Гра напряму в БД (за замовчуванням — `recruiting`, через ~місяць, без повторів). */
async function insertGame(patch: Partial<typeof games.$inferInsert> = {}): Promise<number> {
  const { systems, genres: gs } = await catalog();
  const [r] = await db
    .insert(games)
    .values({
      gmUserId: await gm(),
      title: 'Гра',
      description: '',
      systemId: systems[0]!,
      genreId: gs[0]!,
      format: 'online',
      kind: 'campaign',
      startsAt: new Date(Date.now() + 30 * DAY_MS),
      durationMinutes: 240,
      recurrence: 'none',
      weekdays: [],
      timezone: KYIV,
      minPlayers: 1,
      maxPlayers: 5,
      status: 'recruiting',
      publishedAt: new Date(),
      ...patch,
    })
    .$returningId();
  return r!.id;
}

const search = (body: object, cookie?: string) => call('post', '/api/games/search', cookie, body);
const ids = (res: { body: { items: { id: number }[] } }) => res.body.items.map((i) => i.id);

describe('POST /api/games/search — filters', () => {
  it('filters by system, genre, format and city (case-insensitive)', async () => {
    const { systems, genres: gs } = await catalog();
    const a = await insertGame({ systemId: systems[0]!, genreId: gs[0]! });
    const b = await insertGame({ systemId: systems[1]!, genreId: gs[1]! });
    const c = await insertGame({ format: 'offline', city: 'Київ' });
    const d = await insertGame({ format: 'offline', city: 'Львів' });

    expect(ids(await search({ systemIds: [systems[1]!] }))).toEqual([b]);
    expect(ids(await search({ genreIds: [gs[1]!] }))).toEqual([b]);
    expect(ids(await search({ format: 'offline' })).sort()).toEqual([c, d].sort());
    expect(ids(await search({ city: 'кИЇв' }))).toEqual([c]);
    expect(ids(await search({})).sort()).toEqual([a, b, c, d].sort());
  });

  it("priceMode 'free' → only games without price; priceMax", async () => {
    const free = await insertGame({ priceUah: null });
    const cheap = await insertGame({ priceUah: 100 });
    const pricey = await insertGame({ priceUah: 500 });
    expect(ids(await search({ priceMode: 'free' }))).toEqual([free]);
    expect(ids(await search({ priceMode: 'paid' })).sort()).toEqual([cheap, pricey].sort());
    expect(ids(await search({ priceMode: 'paid', priceMax: 200 }))).toEqual([cheap]);
    expect(ids(await search({ priceMax: 200 })).sort()).toEqual([free, cheap].sort());
  });

  it('excludeWarningIds removes games having any of them', async () => {
    const { warnings } = await catalog();
    const clean = await insertGame();
    const w1 = await insertGame();
    const w2 = await insertGame();
    await db.insert(gameContentWarnings).values([
      { gameId: w1, warningId: warnings[0]! },
      { gameId: w2, warningId: warnings[1]! },
    ]);
    expect(ids(await search({ excludeWarningIds: warnings }))).toEqual([clean]);
    expect(ids(await search({ excludeWarningIds: [warnings[0]!] })).sort()).toEqual(
      [clean, w2].sort(),
    );
  });

  it('hasFreeSlots hides full games; started games only with show_when_full', async () => {
    const p1 = await createUser(db);
    const p2 = await createUser(db);
    const full = await insertGame({ maxPlayers: 2 });
    const startedFull = await insertGame({ maxPlayers: 2, status: 'started', showWhenFull: true });
    const startedHidden = await insertGame({ status: 'started', showWhenFull: false });
    for (const gameId of [full, startedFull]) {
      await db.insert(gameMembers).values([
        { gameId, userId: p1.id },
        { gameId, userId: p2.id },
      ]);
    }
    const all = await search({});
    expect(ids(all).sort()).toEqual([full, startedFull].sort());
    expect(ids(all)).not.toContain(startedHidden);
    expect(all.body.items.every((i: { freeSlots: number }) => i.freeSlots === 0)).toBe(true);
    expect(ids(await search({ hasFreeSlots: true }))).toEqual([]);
  });

  it('drafts, cancelled and finished games never appear', async () => {
    const ok = await insertGame();
    await insertGame({ status: 'draft', publishedAt: null });
    await insertGame({ status: 'cancelled' });
    await insertGame({ status: 'finished' });
    expect(ids(await search({}))).toEqual([ok]);
  });

  it('validates the body', async () => {
    expect((await search({ limit: 0 })).status).toBe(400);
    expect((await search({ nope: 1 })).body.error.code).toBe('VALIDATION');
  });
});

describe('POST /api/games/search — calendar', () => {
  // Вт 19:00–23:00 за Києвом, щотижня.
  const tuesdayGame = () =>
    insertGame({
      startsAt: nextKyiv(1, 19),
      recurrence: 'weekly',
      weekdays: [1],
      durationMinutes: 240,
    });

  async function player(slots: { weekday: number; startMin: number; endMin: number }[]) {
    const p = await userWithAge(25);
    if (slots.length)
      await db.insert(availabilitySlots).values(slots.map((s) => ({ userId: p.id, ...s })));
    return p;
  }

  it("mine: player free Tue 18:00–23:30 → fit 'full'; without the slot → absent", async () => {
    const id = await tuesdayGame();
    const fits = await player([{ weekday: 1, startMin: 18 * 60, endMin: 23 * 60 + 30 }]);
    const res = await search({ calendar: { mode: 'mine' } }, fits.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id, fit: 'full' });

    const busy = await player([{ weekday: 2, startMin: 18 * 60, endMin: 23 * 60 + 30 }]);
    expect(ids(await search({ calendar: { mode: 'mine' } }, busy.cookie))).toEqual([]);
  });

  it('fit is present only when the calendar is on', async () => {
    await tuesdayGame();
    const res = await search({});
    expect(res.body.items[0]).not.toHaveProperty('fit');
  });

  it('mine without a session → 401', async () => {
    const res = await search({ calendar: { mode: 'mine' } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('partial fits pass only with includePartial', async () => {
    // Вт і Чт; гравець вільний лише у вівторок → щонайменше половина сесій.
    const id = await insertGame({
      startsAt: nextKyiv(1, 19),
      recurrence: 'weekly',
      weekdays: [1, 3],
    });
    const p = await player([{ weekday: 1, startMin: 18 * 60, endMin: 24 * 60 }]);
    expect(ids(await search({ calendar: { mode: 'mine' } }, p.cookie))).toEqual([]);
    const res = await search({ calendar: { mode: 'mine', includePartial: true } }, p.cookie);
    expect(res.body.items).toEqual([expect.objectContaining({ id, fit: 'partial' })]);
  });

  it('custom availability works for guests', async () => {
    const id = await tuesdayGame();
    const res = await search({
      calendar: {
        mode: 'custom',
        availability: {
          timezone: KYIV,
          slots: [{ weekday: 1, startMin: 18 * 60, endMin: 24 * 60 }],
          busyDates: [],
        },
      },
    });
    expect(res.body.items).toEqual([expect.objectContaining({ id, fit: 'full' })]);
  });
});

describe('POST /api/games/search — paging and visibility', () => {
  async function collect(body: object, cookie?: string) {
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const res = await search({ ...body, ...(cursor ? { cursor } : {}) }, cookie);
      expect(res.status).toBe(200);
      pages.push(ids(res));
      cursor = res.body.nextCursor;
    } while (cursor && pages.length < 20);
    return pages;
  }

  it('25 games, limit 20 → 20 + cursor → 5 and null, no duplicates (soonest)', async () => {
    const base = Date.now() + 10 * DAY_MS;
    const created: { id: number; at: number }[] = [];
    // 5 різних моментів, по 5 ігор на кожен — перевіряє розв'язання нічиїх за id.
    for (let i = 0; i < 25; i++) {
      const at = base + (i % 5) * DAY_MS;
      created.push({ id: await insertGame({ startsAt: new Date(at) }), at });
    }
    const expected = created.sort((a, b) => a.at - b.at || a.id - b.id).map((c) => c.id);
    const first = await search({ limit: 20 });
    expect(first.body.items).toHaveLength(20);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await search({ limit: 20, cursor: first.body.nextCursor });
    expect(second.body.items).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    expect([...ids(first), ...ids(second)]).toEqual(expected);
  });

  it('newest sorts by published_at desc then id desc', async () => {
    const t = Date.now() - 10 * DAY_MS;
    const a = await insertGame({ publishedAt: new Date(t) });
    const b = await insertGame({ publishedAt: new Date(t + DAY_MS) });
    const c = await insertGame({ publishedAt: new Date(t + DAY_MS) });
    const pages = await collect({ sort: 'newest', limit: 2 });
    expect(pages).toEqual([[c, b], [a]]);
  });

  it('calendar filter dropping rows never skips or duplicates across pages', async () => {
    const tue = nextKyiv(1, 19);
    const expected: number[] = [];
    for (let i = 0; i < 30; i++) {
      // Однаковий startsAt (порядок за id); кожна третя гра триває до 01:00 середи —
      // гравцю не підходить, тож відкинуті рядки перемежовуються з придатними.
      const late = i % 3 === 0;
      const id = await insertGame({
        startsAt: tue,
        recurrence: 'weekly',
        weekdays: [1],
        durationMinutes: late ? 360 : 240,
      });
      if (!late) expected.push(id);
    }
    const p = await userWithAge(25);
    await db
      .insert(availabilitySlots)
      .values({ userId: p.id, weekday: 1, startMin: 18 * 60, endMin: 24 * 60 });
    const pages = await collect({ calendar: { mode: 'mine' }, limit: 4 }, p.cookie);
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort((x, y) => x - y)).toEqual(expected.sort((x, y) => x - y));
    expect(pages.at(-1)!.length).toBeGreaterThan(0);
  });

  it('garbage or mismatched cursor → 400 VALIDATION', async () => {
    for (const cursor of ['%%%', 'bm9wZQ', Buffer.from('{"k":1}').toString('base64url')]) {
      const res = await search({ cursor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
    for (let i = 0; i < 3; i++) await insertGame();
    const first = await search({ limit: 1 });
    const res = await search({ limit: 1, sort: 'newest', cursor: first.body.nextCursor });
    expect(res.status).toBe(400);
  });

  it('18+ game for a guest has exactly the restricted keys (Review Focus 3)', async () => {
    const id = await insertGame({ ageRating: '18+', city: 'Київ' });
    const res = await search({});
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['ageRating', 'gm', 'id', 'restricted', 'title'].sort(),
    );
    expect(res.body.items[0]).toMatchObject({ id, restricted: true });

    const minor = await userWithAge(16);
    const asMinor = await search({}, minor.cookie);
    expect(asMinor.body.items[0].restricted).toBe(true);
    const adult = await userWithAge(25);
    const asAdult = await search({}, adult.cookie);
    expect(asAdult.body.items[0]).not.toHaveProperty('restricted');
    expect(asAdult.body.items[0].city).toBe('Київ');
  });

  it('restricted cards carry no fit even with the calendar on', async () => {
    await insertGame({
      ageRating: '21+',
      startsAt: nextKyiv(1, 19),
      recurrence: 'weekly',
      weekdays: [1],
    });
    const res = await search({
      calendar: {
        mode: 'custom',
        availability: {
          timezone: KYIV,
          slots: [{ weekday: 1, startMin: 0, endMin: 24 * 60 }],
          busyDates: [],
        },
      },
    });
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['ageRating', 'gm', 'id', 'restricted', 'title'].sort(),
    );
  });
});
