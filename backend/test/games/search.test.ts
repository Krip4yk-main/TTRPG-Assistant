import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
  publishedRatings,
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

  it('full games: hidden unless show_when_full; hasFreeSlots hides all full games', async () => {
    const p1 = await createUser(db);
    const p2 = await createUser(db);
    const fullHidden = await insertGame({ maxPlayers: 2 });
    const fullShown = await insertGame({ maxPlayers: 2, showWhenFull: true });
    const startedFull = await insertGame({ maxPlayers: 2, status: 'started', showWhenFull: true });
    const startedHidden = await insertGame({ status: 'started', showWhenFull: false });
    const open = await insertGame({ maxPlayers: 3 });
    for (const gameId of [fullHidden, fullShown, startedFull, open]) {
      await db.insert(gameMembers).values([
        { gameId, userId: p1.id },
        { gameId, userId: p2.id },
      ]);
    }
    const all = await search({});
    expect(ids(all).sort()).toEqual([fullShown, startedFull, open].sort());
    expect(ids(all)).not.toContain(fullHidden);
    expect(ids(all)).not.toContain(startedHidden);
    expect(ids(await search({ hasFreeSlots: true }))).toEqual([open]);
  });

  it('former members do not fill a game', async () => {
    const p1 = await createUser(db);
    const p2 = await createUser(db);
    const game = await insertGame({ maxPlayers: 2 });
    await db.insert(gameMembers).values([
      { gameId: game, userId: p1.id },
      { gameId: game, userId: p2.id, leftAt: new Date(), leftReason: 'kicked' },
    ]);
    expect(ids(await search({ hasFreeSlots: true }))).toEqual([game]);
  });

  it("experience 'any' is no filter; other levels include 'any' games", async () => {
    const any = await insertGame({ experience: 'any' });
    const beg = await insertGame({ experience: 'beginner' });
    const exp = await insertGame({ experience: 'experienced' });
    expect(ids(await search({ experience: 'any' })).sort()).toEqual([any, beg, exp].sort());
    expect(ids(await search({ experience: 'beginner' })).sort()).toEqual([any, beg].sort());
  });

  it('drafts, cancelled and finished games never appear', async () => {
    const ok = await insertGame();
    await insertGame({ status: 'draft', publishedAt: null });
    await insertGame({ status: 'cancelled' });
    await insertGame({ status: 'finished' });
    expect(ids(await search({}))).toEqual([ok]);
  });

  it('past one-shots disappear; future one-shots and running campaigns stay', async () => {
    const pastOneShot = await insertGame({
      kind: 'oneshot',
      recurrence: 'none',
      startsAt: new Date(Date.now() - DAY_MS),
    });
    const futureOneShot = await insertGame({
      kind: 'oneshot',
      recurrence: 'none',
      startsAt: new Date(Date.now() + DAY_MS),
    });
    const runningCampaign = await insertGame({
      kind: 'campaign',
      recurrence: 'weekly',
      weekdays: [1],
      startsAt: new Date(Date.now() - 14 * DAY_MS),
    });
    const soonest = ids(await search({ sort: 'soonest' }));
    expect(soonest).not.toContain(pastOneShot);
    expect(soonest).toEqual([runningCampaign, futureOneShot]);
    expect(ids(await search({ sort: 'newest' }))).not.toContain(pastOneShot);
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

describe('POST /api/games/search — busy time from joined games', () => {
  const slots = [{ weekday: 1, startMin: 18 * 60, endMin: 23 * 60 + 30 }];
  const tuesday = (hour = 19, patch: Partial<typeof games.$inferInsert> = {}) =>
    insertGame({
      startsAt: nextKyiv(1, hour),
      recurrence: 'weekly',
      weekdays: [1],
      durationMinutes: 240,
      ...patch,
    });
  async function playerIn(gameId: number) {
    const p = await userWithAge(25);
    await db.insert(availabilitySlots).values(slots.map((s) => ({ userId: p.id, ...s })));
    await db.insert(gameMembers).values({ gameId, userId: p.id });
    return p;
  }

  it("mine: a game overlapping an accepted one gets 'none' (dropped); the joined game itself still fits", async () => {
    const joined = await tuesday();
    const other = await tuesday();
    const p = await playerIn(joined);
    const res = await search({ calendar: { mode: 'mine', includePartial: true } }, p.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([expect.objectContaining({ id: joined, fit: 'full' })]);
    expect(ids(res)).not.toContain(other);
  });

  it('custom mode for a logged-in user also respects busy time; guests are unaffected', async () => {
    const joined = await tuesday();
    const other = await tuesday();
    const p = await playerIn(joined);
    const calendar = {
      mode: 'custom',
      availability: { timezone: KYIV, slots, busyDates: [] },
    };
    expect(ids(await search({ calendar }, p.cookie))).toEqual([joined]);
    expect(ids(await search({ calendar })).sort()).toEqual([joined, other].sort());
  });

  it('busy time ignored when the membership ended or autobusy is off (unless pinned)', async () => {
    const joined = await tuesday();
    const other = await tuesday();
    const p = await playerIn(joined);
    await call('patch', '/api/me/settings', p.cookie, { calendarAutoBusy: false });
    const body = { calendar: { mode: 'mine' } };
    expect(ids(await search(body, p.cookie)).sort()).toEqual([joined, other].sort());
    await call('post', `/api/me/calendar/pinned-games/${joined}`, p.cookie);
    expect(ids(await search(body, p.cookie))).toEqual([joined]);
    await db
      .update(gameMembers)
      .set({ leftAt: new Date(), leftReason: 'left' })
      .where(eq(gameMembers.userId, p.id));
    expect(ids(await search(body, p.cookie)).sort()).toEqual([joined, other].sort());
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

  it('running (started) games go after all recruiting ones, across pages too', async () => {
    const base = Date.now() + 10 * DAY_MS;
    // Кампанія, що вже йде: перша сесія раніше за всі інші й опублікована найпізніше.
    const started = await insertGame({
      status: 'started',
      showWhenFull: true,
      recurrence: 'weekly',
      weekdays: [0],
      startsAt: new Date(Date.now() - 20 * DAY_MS),
      publishedAt: new Date(Date.now() - 1000),
    });
    const r1 = await insertGame({
      startsAt: new Date(base),
      publishedAt: new Date(Date.now() - 3 * DAY_MS),
    });
    const r2 = await insertGame({
      startsAt: new Date(base + DAY_MS),
      publishedAt: new Date(Date.now() - 2 * DAY_MS),
    });
    expect(ids(await search({}))).toEqual([r1, r2, started]);
    expect(await collect({ limit: 1 })).toEqual([[r1], [r2], [started]]);
    expect(ids(await search({ sort: 'newest' }))).toEqual([r2, r1, started]);
    expect(await collect({ sort: 'newest', limit: 1 })).toEqual([[r2], [r1], [started]]);
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

  it('cursor is opaque and tamper-evident', async () => {
    for (let i = 0; i < 3; i++) await insertGame();
    const first = await search({ limit: 1 });
    const cursor = first.body.nextCursor as string;
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(() => JSON.parse(raw)).toThrow();
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect((await search({ limit: 1, cursor })).status).toBe(200);
    const bytes = Buffer.from(cursor, 'base64url');
    bytes[bytes.length - 1]! ^= 1;
    const flipped = await search({ limit: 1, cursor: bytes.toString('base64url') });
    expect(flipped.status).toBe(400);
    expect(flipped.body.error.code).toBe('VALIDATION');
  });

  it('detail filters never return games the viewer is too young for', async () => {
    const { warnings } = await catalog();
    const adultGame = await insertGame({
      ageRating: '18+',
      format: 'offline',
      city: 'Київ',
      priceUah: null,
      startsAt: nextKyiv(1, 19),
      recurrence: 'weekly',
      weekdays: [1],
    });
    const calendar = {
      mode: 'custom',
      availability: {
        timezone: KYIV,
        slots: [{ weekday: 1, startMin: 0, endMin: 24 * 60 }],
        busyDates: [],
      },
    };
    const probes: object[] = [
      { city: 'Київ' },
      { priceMode: 'free' },
      { excludeWarningIds: [warnings[0]!] },
      { calendar },
      { hasFreeSlots: true },
    ];
    for (const probe of probes) {
      expect(ids(await search(probe))).toEqual([]);
    }
    // Без детальних фільтрів гість бачить обмежену картку; ageRatings — не детальний фільтр.
    expect((await search({})).body.items).toEqual([
      expect.objectContaining({ id: adultGame, restricted: true }),
    ]);
    expect(ids(await search({ ageRatings: ['18+'] }))).toEqual([adultGame]);
    // 18–20 не проходить лише 21+.
    const young = await userWithAge(19);
    expect(ids(await search({ city: 'Київ' }, young.cookie))).toEqual([adultGame]);
    const g21 = await insertGame({ ageRating: '21+', format: 'offline', city: 'Київ' });
    expect(ids(await search({ city: 'Київ' }, young.cookie))).toEqual([adultGame]);
    const adult = await userWithAge(25);
    expect(ids(await search({ city: 'Київ' }, adult.cookie)).sort()).toEqual(
      [adultGame, g21].sort(),
    );
  });

  it('GM keeps their own restricted game under detail filters', async () => {
    const gmUser = await userWithAge(19);
    const own = await insertGame({
      ageRating: '21+',
      format: 'offline',
      city: 'Київ',
      gmUserId: gmUser.id,
    });
    const other = await insertGame({ ageRating: '21+', format: 'offline', city: 'Київ' });
    expect(ids(await search({ city: 'Київ' }, gmUser.cookie))).toEqual([own]);
    expect(ids(await search({ city: 'Київ' }))).not.toContain(other);
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

  it('a logged-in 17-year-old gets exactly the restricted keys for an 18+ game', async () => {
    const id = await insertGame({ ageRating: '18+', city: 'Київ', priceUah: 200 });
    const teen = await userWithAge(17);
    const res = await search({}, teen.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(
      ['ageRating', 'gm', 'id', 'restricted', 'title'].sort(),
    );
    expect(res.body.items[0]).toMatchObject({ id, restricted: true, ageRating: '18+' });
  });
});

describe('POST /api/games/search — gm_rating', () => {
  /** Майстер з опублікованим рейтингом (`overall` — як у БД, 2 знаки). */
  async function gmWith(overall: number | null, units = 5): Promise<number> {
    const u = await createUser(db, { nickname: `Gm ${overall}` });
    if (overall !== null || units > 0) {
      await db.insert(publishedRatings).values({
        userId: u.id,
        role: 'gm',
        overall,
        overallUnits: units,
        units,
        criteria: {},
        lastRatingId: 1,
        publishedAt: new Date(),
      });
    }
    return u.id;
  }

  async function collect(body: object) {
    const pages: number[][] = [];
    let cursor: string | null = null;
    do {
      const res = await search({ ...body, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      pages.push(ids(res));
      cursor = res.body.nextCursor;
    } while (cursor && pages.length < 20);
    return pages;
  }

  it('orders by GM rating desc, unrated after, running campaigns last; cursor across pages', async () => {
    const top = await gmWith(4.85);
    const mid = await gmWith(4.25);
    const placeholder = await gmWith(null, 0); // заготовка без зрізу — як без рейтингу
    // Зріз нижче порогу (4 одиниці) — як без рейтингу і в порядку, і в ключі курсора.
    const few = await gmWith(4.95, 4);
    const none = await createUser(db, { nickname: 'New Gm' });
    const a = await insertGame({ gmUserId: mid });
    const b = await insertGame({ gmUserId: top });
    const c = await insertGame({ gmUserId: mid }); // нічия з `a` → за id спадно
    const d = await insertGame({ gmUserId: none.id });
    const e = await insertGame({ gmUserId: placeholder });
    const f = await insertGame({ gmUserId: few });
    const running = await insertGame({
      gmUserId: top,
      status: 'started',
      showWhenFull: true,
      recurrence: 'weekly',
      weekdays: [0],
      startsAt: new Date(Date.now() - 20 * DAY_MS),
    });
    const runningUnrated = await insertGame({
      gmUserId: none.id,
      status: 'started',
      showWhenFull: true,
      recurrence: 'weekly',
      weekdays: [0],
      startsAt: new Date(Date.now() - 20 * DAY_MS),
    });
    const expected = [b, c, a, f, e, d, running, runningUnrated];
    const all = await search({ sort: 'gm_rating' });
    expect(ids(all)).toEqual(expected);
    expect(all.body.items.map((i: { gmRating: number | null }) => i.gmRating)).toEqual([
      4.9,
      4.3,
      4.3,
      null,
      null,
      null,
      4.9,
      null,
    ]);
    for (const limit of [1, 2, 3]) {
      const pages = await collect({ sort: 'gm_rating', limit });
      expect(pages.flat()).toEqual(expected);
    }
    // Курсор іншого сортування — 400.
    const first = await search({ sort: 'gm_rating', limit: 1 });
    expect((await search({ sort: 'soonest', cursor: first.body.nextCursor })).status).toBe(400);
    const soon = await search({ sort: 'soonest', limit: 1 });
    expect((await search({ sort: 'gm_rating', cursor: soon.body.nextCursor })).status).toBe(400);
  });

  it('card summary: description excerpt in one line, cut with «…»; none on a restricted card', async () => {
    const short = await insertGame({ description: '  Готичний жах\n\nу тумані.  ' });
    const long = await insertGame({ description: `${'слово '.repeat(60)}кінець` });
    const empty = await insertGame({ description: '' });
    const adult = await insertGame({ description: 'Таємниця', ageRating: '18+' });
    const res = await search({});
    const byId = new Map(res.body.items.map((i: { id: number }) => [i.id, i]));
    expect(byId.get(short)).toMatchObject({ summary: 'Готичний жах у тумані.' });
    const cut = (byId.get(long) as { summary: string }).summary;
    expect(cut.endsWith('слово…')).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(200);
    expect(cut).not.toContain('кінець');
    expect(byId.get(empty)).toMatchObject({ summary: null });
    expect(byId.get(adult)).not.toHaveProperty('summary');
    expect(JSON.stringify(res.body)).not.toContain('Таємниця');
  });

  it('gmRating on cards and details; null below 5 units; no rating on a restricted card', async () => {
    const rated = await gmWith(3.95);
    const few = await gmWith(4.7, 4);
    const g = await insertGame({ gmUserId: rated });
    const h = await insertGame({ gmUserId: few });
    const adult = await insertGame({ gmUserId: rated, ageRating: '18+' });
    const res = await search({ sort: 'gm_rating' });
    const byId = new Map(res.body.items.map((i: { id: number }) => [i.id, i]));
    expect(byId.get(g)).toMatchObject({ gmRating: 4 });
    expect(byId.get(h)).toMatchObject({ gmRating: null });
    expect(byId.get(adult)).not.toHaveProperty('gmRating');
    expect(Object.keys(byId.get(adult) as object).sort()).toEqual(
      ['ageRating', 'gm', 'id', 'restricted', 'title'].sort(),
    );
    const details = await call('get', `/api/games/${g}`);
    expect(details.status).toBe(200);
    expect(details.body.gmRating).toBe(4);
    expect((await call('get', `/api/games/${h}`)).body.gmRating).toBeNull();
    const restricted = await call('get', `/api/games/${adult}`);
    expect(restricted.body).not.toHaveProperty('gmRating');
    // Картка — лише загальна: ні кількості, ні критеріїв, ні полів окремих оцінок.
    const json = JSON.stringify(res.body);
    for (const leak of ['units', 'criteria', 'raterId', 'comment', 'lastRatingId']) {
      expect(json).not.toContain(leak);
    }
  });
});
