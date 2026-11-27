import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import ICAL from 'ical.js';
import { createApp } from '../../src/app.js';
import {
  calendarFeeds,
  gameMembers,
  gameSessions,
  games,
  users,
} from '../../src/db/schema/index.js';
import { escapeIcsText, foldIcsLine } from '../../src/calendar/ics.js';
import { renderCalendarFeed } from '../../src/calendar/calendar-feed.service.js';
import { CAL_FEED_TOKEN_MAX } from '../../src/http/security.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis, env } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);
const BASE = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
const HOST = new URL(BASE).hostname;

const logs: string[] = [];
beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
  logs.length = 0;
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
    });
  }
});
const issuedTokens: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  // Токен не логується ніколи.
  for (const t of issuedTokens) for (const l of logs) expect(l).not.toContain(t);
  issuedTokens.length = 0;
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
type User = Awaited<ReturnType<typeof userWithAge>>;

/** Гра в статусі `started` без автоматично згенерованих сесій. */
async function game(gm: User, patch: Record<string, unknown> = {}): Promise<number> {
  const id = await createGame(gm.cookie, patch);
  await db.update(games).set({ status: 'started' }).where(eq(games.id, id));
  await db.delete(gameSessions).where(eq(gameSessions.gameId, id));
  return id;
}

async function session(
  gameId: number,
  startsAt: Date,
  patch: Partial<typeof gameSessions.$inferInsert> = {},
): Promise<number> {
  const [r] = await db
    .insert(gameSessions)
    .values({
      gameId,
      startsAt,
      durationMinutes: 180,
      origin: 'manual',
      updatedAt: new Date(Date.now() - HOUR),
      ...patch,
    })
    .$returningId();
  return r!.id;
}

const member = (gameId: number, userId: number, leftAt: Date | null = null) =>
  db.insert(gameMembers).values({ gameId, userId, leftAt, leftReason: leftAt ? 'left' : null });

async function enable(u: User): Promise<{ url: string; token: string; path: string }> {
  const res = await call('post', '/api/me/calendar-feed', u.cookie);
  expect(res.status).toBe(200);
  const url = res.body.url as string;
  const m = /\/api\/cal\/([A-Za-z0-9_-]+)\.ics$/.exec(url);
  expect(m).not.toBeNull();
  issuedTokens.push(m![1]!);
  return { url, token: m![1]!, path: new URL(url).pathname };
}

/** Публічний запит без cookie та CSRF. */
const fetchFeed = (path: string) => request(app).get(path);

type Ev = {
  uid: string;
  summary: string;
  status: string | null;
  sequence: number;
  start: string;
  end: string;
  url: string | null;
  description: string | null;
  location: string | null;
};

function parseFeed(text: string): Ev[] {
  const comp = new ICAL.Component(ICAL.parse(text));
  expect(comp.name).toBe('vcalendar');
  return comp.getAllSubcomponents('vevent').map((v) => ({
    uid: v.getFirstPropertyValue('uid') as string,
    summary: v.getFirstPropertyValue('summary') as string,
    status: (v.getFirstPropertyValue('status') as string | null) ?? null,
    sequence: Number(v.getFirstPropertyValue('sequence')),
    start: (v.getFirstPropertyValue('dtstart') as ICAL.Time).toJSDate().toISOString(),
    end: (v.getFirstPropertyValue('dtend') as ICAL.Time).toJSDate().toISOString(),
    url: (v.getFirstPropertyValue('url') as string | null) ?? null,
    description: (v.getFirstPropertyValue('description') as string | null) ?? null,
    location: (v.getFirstPropertyValue('location') as string | null) ?? null,
  }));
}

describe('calendar feed owner API', () => {
  it('status → enable → status (no token) → disable', async () => {
    const u = await userWithAge(25, 'u');
    expect((await call('get', '/api/me/calendar-feed')).status).toBe(401);
    const off = await call('get', '/api/me/calendar-feed', u.cookie);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false, createdAt: null });

    const { url, token } = await enable(u);
    expect(url.startsWith(`${BASE}/api/cal/`)).toBe(true);
    // ≥ 32 байти → ≥ 43 символи base64url.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);

    const on = await call('get', '/api/me/calendar-feed', u.cookie);
    expect(on.body.enabled).toBe(true);
    expect(typeof on.body.createdAt).toBe('string');
    expect(JSON.stringify(on.body)).not.toContain(token);

    // У БД — лише SHA-256, сирого токена немає в жодній колонці.
    const rows = await db.select().from(calendarFeeds);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(token);

    const del = await call('delete', '/api/me/calendar-feed', u.cookie);
    expect(del.status).toBe(204);
    expect((await call('get', '/api/me/calendar-feed', u.cookie)).body).toEqual({
      enabled: false,
      createdAt: null,
    });
    expect(await db.select().from(calendarFeeds)).toHaveLength(0);
  });

  it('pending user cannot enable', async () => {
    const u = await userWithAge(25, 'p');
    await db.update(users).set({ status: 'pending' }).where(eq(users.id, u.id));
    expect((await call('post', '/api/me/calendar-feed', u.cookie)).status).toBe(403);
  });
});

describe('GET /api/cal/<token>.ics', () => {
  it('serves a valid VCALENDAR with GM and member sessions only', async () => {
    const gm = await userWithAge(30, 'masterNick');
    const me = await userWithAge(25, 'me');
    const other = await userWithAge(25, 'otherNick');
    // Цілі секунди: `starts_at` — DATETIME без дробової частини (MySQL округлює).
    const now = Math.floor(Date.now() / 1000) * 1000;

    const myGame = await game(me, { title: 'Моя гра', format: 'offline', city: 'Київ' });
    const s1 = await session(myGame, new Date(now + 2 * DAY));
    const joined = await game(gm, { title: 'Гра майстра', platform: 'Foundry' });
    await member(joined, me.id);
    await member(joined, other.id);
    const s2 = await session(joined, new Date(now + 3 * DAY), {
      summary: 'ТАЄМНИЙ ПІДСУМОК',
      summarySentAt: new Date(now),
    });
    const s3 = await session(joined, new Date(now + 4 * DAY), {
      status: 'cancelled',
      cancelReason: 'ПРИЧИНА СКАСУВАННЯ',
    });
    const past = await session(joined, new Date(now - 10 * DAY), { status: 'done' });
    // Поза вікном.
    await session(joined, new Date(now - 40 * DAY));
    await session(joined, new Date(now + 200 * DAY));
    // Чужа гра і гра, з якої вийшов.
    const foreign = await game(other, { title: 'Чужа гра' });
    await session(foreign, new Date(now + 2 * DAY));
    const leftGame = await game(gm, { title: 'Покинута гра' });
    await member(leftGame, me.id, new Date(now - DAY));
    await session(leftGame, new Date(now + 2 * DAY));

    const { path } = await enable(me);
    const res = await fetchFeed(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.headers['set-cookie']).toBeUndefined();
    const text = res.text;
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);

    const evs = parseFeed(text);
    expect(evs.map((e) => e.uid).sort()).toEqual(
      [s1, s2, s3, past].map((id) => `session-${id}@${HOST}`).sort(),
    );
    const e1 = evs.find((e) => e.uid === `session-${s1}@${HOST}`)!;
    expect(e1.summary).toBe('Моя гра');
    expect(e1.status).toBe('CONFIRMED');
    expect(e1.start).toBe(new Date(now + 2 * DAY).toISOString());
    expect(Date.parse(e1.end) - Date.parse(e1.start)).toBe(180 * 60_000);
    expect(e1.url).toBe(`${BASE}/games/${myGame}`);
    expect(e1.description).toContain(`${BASE}/games/${myGame}`);
    expect(e1.location).toBe('Київ');
    const e2 = evs.find((e) => e.uid === `session-${s2}@${HOST}`)!;
    expect(e2.summary).toBe('Гра майстра');
    expect(e2.location).toBe('Онлайн · Foundry');
    expect(evs.find((e) => e.uid === `session-${s3}@${HOST}`)!.status).toBe('CANCELLED');
    // DTSTART/DTEND — у UTC.
    expect(text).toMatch(/\r\nDTSTART:\d{8}T\d{6}Z\r\n/);
    expect(text).toMatch(/\r\nDTEND:\d{8}T\d{6}Z\r\n/);
    expect(text).not.toMatch(/TZID/);
    // Жодних даних інших учасників, підсумків, причин скасування, адрес.
    for (const secret of ['ТАЄМНИЙ', 'ПРИЧИНА', 'otherNick', 'masterNick', 'Таємна', 'discord']) {
      expect(text).not.toContain(secret);
    }
  });

  it('reschedule bumps SEQUENCE, keeps UID', async () => {
    const me = await userWithAge(25, 'me');
    const g = await game(me);
    const s = await session(g, new Date(Date.now() + 2 * DAY));
    const { path } = await enable(me);
    const [before] = parseFeed((await fetchFeed(path)).text);
    await db
      .update(gameSessions)
      .set({ startsAt: new Date(Date.now() + 3 * DAY), rescheduled: true })
      .where(eq(gameSessions.id, s));
    const [after] = parseFeed((await fetchFeed(path)).text);
    expect(after!.uid).toBe(before!.uid);
    expect(after!.sequence).toBeGreaterThan(before!.sequence);
    expect(before!.sequence).toBeGreaterThanOrEqual(0);
    expect(after!.start).not.toBe(before!.start);
  });

  it('approximate time: DTSTART = window start, DTEND = window end + duration, marked summary', async () => {
    const me = await userWithAge(25, 'me');
    const g = await game(me, { title: 'Вікно' });
    // Цілі хвилини: `starts_at` — DATETIME без дробу.
    const start = new Date(Math.floor((Date.now() + 2 * DAY) / 60_000) * 60_000);
    await session(g, start, { startWindowMinutes: 120 });
    await session(g, new Date(start.getTime() + DAY));
    const { path } = await enable(me);
    const text = (await fetchFeed(path)).text;
    const unfolded = text.replace(/\r\n[ \t]/g, '');
    const stamp = (d: Date) =>
      d
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/[-:]/g, '');
    expect(unfolded).toContain(`DTSTART:${stamp(start)}`);
    // Кінець вікна (+120) + тривалість (180).
    expect(unfolded).toContain(`DTEND:${stamp(new Date(start.getTime() + 300 * 60_000))}`);
    expect(unfolded).toContain('SUMMARY:Вікно (час уточнюється)');
    expect(parseFeed(text).map((e) => e.summary)).toEqual(['Вікно (час уточнюється)', 'Вікно']);
  });

  it('approximate time across the spring DST switch: DTEND in UTC ms', async () => {
    const me = await userWithAge(25, 'me');
    const g = await game(me, { title: 'Ніч' });
    // Київ, 28.03.2027: 03:00 EET → 04:00 EEST. Вікно 02:00 EET (00:00 UTC) + 180 хв, сесія 60 хв.
    await session(g, new Date('2027-03-28T00:00:00.000Z'), {
      startWindowMinutes: 180,
      durationMinutes: 60,
    });
    const { token } = await enable(me);
    const text = (await renderCalendarFeed(deps, `${token}.ics`, new Date('2027-03-20T00:00Z')))!;
    const [ev] = parseFeed(text);
    expect(ev!.start).toBe('2027-03-28T00:00:00.000Z');
    expect(ev!.end).toBe('2027-03-28T04:00:00.000Z');
  });

  it('reissue: old token 404, new 200; DELETE → 404; unknown → 404', async () => {
    const me = await userWithAge(25, 'me');
    const first = await enable(me);
    expect((await fetchFeed(first.path)).status).toBe(200);
    const second = await enable(me);
    expect(second.token).not.toBe(first.token);
    expect((await db.select().from(calendarFeeds)).length).toBe(1);
    const old = await fetchFeed(first.path);
    expect(old.status).toBe(404);
    expect(old.body).toEqual({ error: { code: 'NOT_FOUND' } });
    expect((await fetchFeed(second.path)).status).toBe(200);

    expect((await call('delete', '/api/me/calendar-feed', me.cookie)).status).toBe(204);
    expect((await fetchFeed(second.path)).status).toBe(404);

    const unknown = 'A'.repeat(43);
    for (const p of [`/api/cal/${unknown}.ics`, '/api/cal/short.ics', `/api/cal/${unknown}`]) {
      const r = await fetchFeed(p);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'NOT_FOUND' } });
    }
  });

  it('banned or deleted user → 404', async () => {
    const a = await userWithAge(25, 'a');
    const b = await userWithAge(25, 'b');
    const fa = await enable(a);
    const fb = await enable(b);
    await db.update(users).set({ isBanned: true }).where(eq(users.id, a.id));
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, b.id));
    expect((await fetchFeed(fa.path)).status).toBe(404);
    expect((await fetchFeed(fb.path)).status).toBe(404);
  });

  it('escapes text and folds long lines (RFC 5545)', async () => {
    const me = await userWithAge(25, 'me');
    const g = await game(me);
    const title = `Гра, з; комою\nі рядком \\ ${'дуже довга назва '.repeat(6)}`.slice(0, 120);
    await db.update(games).set({ title }).where(eq(games.id, g));
    await session(g, new Date(Date.now() + DAY));
    const { path } = await enable(me);
    const text = (await fetchFeed(path)).text;
    const lines = text.split('\r\n');
    for (const l of lines) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    const unfolded = text.replace(/\r\n[ \t]/g, '');
    expect(unfolded).toContain('SUMMARY:Гра\\, з\\; комою\\nі рядком \\\\ дуже');
    // Фолдинг не розриває багатобайтні символи: розбір повертає назву без змін.
    expect(parseFeed(text)[0]!.summary).toBe(title);
  });

  it('counts accesses per token: over the limit → 429', async () => {
    const me = await userWithAge(25, 'me');
    const { path, token } = await enable(me);
    for (let i = 0; i < CAL_FEED_TOKEN_MAX; i++) {
      expect((await fetchFeed(path)).status).toBe(200);
    }
    expect((await fetchFeed(path)).status).toBe(429);
    // Ключ ліміту в Redis — не сирий токен.
    const keys = await redis.keys('*');
    for (const k of keys) expect(k).not.toContain(token);
    const [row] = await db
      .select({ at: calendarFeeds.lastAccessAt })
      .from(calendarFeeds)
      .where(sql`1 = 1`);
    expect(row!.at).not.toBeNull();
  });
});

describe('ics helpers', () => {
  it('escapeIcsText', () => {
    expect(escapeIcsText('a\\b,c;d\r\ne\nf\rg')).toBe('a\\\\b\\,c\\;d\\ne\\nf\\ng');
  });
  it('foldIcsLine keeps ≤ 75 octets and code points intact', () => {
    const line = `SUMMARY:${'ї😀'.repeat(40)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) expect(p.startsWith(' ')).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
    expect(foldIcsLine('SHORT:x')).toBe('SHORT:x');
  });
});
