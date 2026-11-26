import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  CALENDAR_IMPORT_MAX_FAILURES,
  notificationLink,
  toZoned,
  zonedToUtc,
  type CalendarImportErrorCode,
  type Weekday,
} from '@nri/shared';
import { createApp, type AppDeps } from '../../src/app.js';
import {
  availabilitySlots,
  calendarImportBusy,
  calendarImports,
  notifications,
} from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';
import { AppError } from '../../src/http/errors.js';
import { decryptUrl, encryptUrl, importKey } from '../../src/scheduling/ical/crypto.js';
import { CalendarImportError } from '../../src/scheduling/ical/errors.js';
import { parseIcsBusy } from '../../src/scheduling/ical/ics-parse.js';
import {
  getCalendarImport,
  putCalendarImport,
  runCalendarImportSync,
  syncCalendarImportNow,
} from '../../src/scheduling/ical/calendar-import.service.js';
import { computeCommonTimes } from '../../src/scheduling/common-times.service.js';
import { runCalendarReminders } from '../../src/scheduling/calendar-reminder.service.js';
import { games } from '../../src/db/schema/index.js';
import { importSlots, IMPORT_SLOTS } from '../../src/scheduling/ical/slots.js';

/** Секретна частина посилання — не має з'явитись ні у відповідях, ні в БД, ні в логах. */
const SECRET = 'private-9f8e7d6c5b4a';
const URL_OK = `https://calendar.google.com/calendar/ical/me%40gmail.com/${SECRET}/basic.ics`;

let nextFetch: (url: URL) => Promise<string>;
const fetched: string[] = [];
const base = await testDeps();
const deps: AppDeps = {
  ...base,
  icsFetcher: async (url) => {
    fetched.push(url.href);
    return nextFetch(url);
  },
  // Розбір у процесі (швидше); робочий потік перевірено в ical-parse.test.ts.
  icsParser: async (input) => parseIcsBusy(input),
};
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

const logs: string[] = [];
beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
  fetched.length = 0;
  logs.length = 0;
  nextFetch = async () => cal();
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // Ledger (c): посилання не логується ніколи.
  for (const l of logs) expect(l).not.toContain(SECRET);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const KYIV = 'Europe/Kyiv';
const ics = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const ev = (start: Date, end: Date, ...extra: string[]) =>
  [
    'BEGIN:VEVENT',
    `UID:${start.getTime()}-${end.getTime()}`,
    `DTSTART:${ics(start)}`,
    `DTEND:${ics(end)}`,
    'SUMMARY:Лікар',
    'LOCATION:Таємна вулиця',
    ...extra,
    'END:VEVENT',
  ].join('\r\n');
const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const failWith = (reason: CalendarImportErrorCode) => async () => {
  throw new CalendarImportError(reason);
};

async function connect(userId: number, now = new Date(), url = URL_OK) {
  return putCalendarImport(deps, userId, { url }, now);
}

describe('calendar import API (RF 3, ledger c)', () => {
  it('connect: URL validated, fetched once, stored encrypted; GET/PUT never return it', async () => {
    const u = await userWithAge(25, 'u');
    const empty = await call('get', '/api/me/calendar-import', u.cookie);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({
      available: true,
      connected: false,
      host: null,
      eventsCount: 0,
    });
    expect((await call('get', '/api/me/calendar-import')).status).toBe(401);

    const now = Date.now();
    nextFetch = async () =>
      cal(
        ev(new Date(now + DAY), new Date(now + DAY + HOUR)),
        ev(new Date(now + DAY + HOUR / 2), new Date(now + DAY + 2 * HOUR)),
        ev(new Date(now + 2 * DAY), new Date(now + 2 * DAY + HOUR), 'TRANSP:TRANSPARENT'),
        ev(new Date(now + 3 * DAY), new Date(now + 3 * DAY + HOUR), 'STATUS:CANCELLED'),
        ev(new Date(now + 70 * DAY), new Date(now + 70 * DAY + HOUR)), // поза горизонтом 8 тижнів
      );
    const put = await call('put', '/api/me/calendar-import', u.cookie, {
      url: URL_OK.replace('https:', 'webcal:'),
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      available: true,
      connected: true,
      host: 'calendar.google.com',
      lastError: null,
      failures: 0,
      broken: false,
      eventsCount: 2,
    });
    expect(put.body.lastSyncAt).toBeTruthy();
    expect(put.body.nextManualSyncAt).toBeTruthy();
    expect(fetched).toEqual([URL_OK]);
    const get = await call('get', '/api/me/calendar-import', u.cookie);
    for (const body of [put.body, get.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('/calendar/ical');
      expect(Object.keys(body).sort()).toEqual(
        [
          'available',
          'broken',
          'connected',
          'eventsCount',
          'failures',
          'host',
          'lastAttemptAt',
          'lastError',
          'lastSyncAt',
          'nextManualSyncAt',
          'truncated',
        ].sort(),
      );
    }

    // Збережено: зашифроване посилання (AAD — власник) і злиті інтервали без назв.
    const [row] = await db.select().from(calendarImports).where(eq(calendarImports.userId, u.id));
    expect(row!.urlEnc).not.toContain(SECRET);
    expect(row!.urlEnc.startsWith('v1.')).toBe(true);
    const key = importKey(deps.env);
    expect(decryptUrl(key, u.id, row!.urlEnc)).toBe(URL_OK);
    expect(() => decryptUrl(key, u.id + 1, row!.urlEnc)).toThrow();
    // Випадковий IV — однакові посилання шифруються по-різному.
    expect(encryptUrl(key, u.id, URL_OK)).not.toBe(encryptUrl(key, u.id, URL_OK));
    const busy = await db
      .select()
      .from(calendarImportBusy)
      .where(eq(calendarImportBusy.userId, u.id));
    expect(busy.map((b) => [b.startsAt.getTime(), b.endsAt.getTime()])).toEqual([
      [Math.floor((now + DAY) / 1000) * 1000, Math.floor((now + DAY + 2 * HOUR) / 1000) * 1000],
    ]);
    expect(JSON.stringify(busy)).not.toMatch(/Лікар|Таємна/);
  });

  it('bad URLs are 400 without fetching; a failed fetch is 422 and stores nothing', async () => {
    const u = await userWithAge(25, 'u');
    const put = (url: string) => call('put', '/api/me/calendar-import', u.cookie, { url });
    for (const [url, reason] of [
      ['http://calendar.google.com/x.ics', 'invalid_url'],
      ['https://127.0.0.1/x.ics', 'blocked_address'],
      ['https://[::1]/x.ics', 'blocked_address'],
      ['https://10.0.0.8/x.ics', 'blocked_address'],
      ['https://169.254.169.254/latest', 'blocked_address'],
      ['https://localhost/x.ics', 'blocked_address'],
    ] as const) {
      const r = await put(url);
      expect(r.status, url).toBe(400);
      expect(r.body.error).toEqual({ code: 'CALENDAR_IMPORT_URL_INVALID', details: { reason } });
    }
    expect((await put('')).status).toBe(400);
    expect(fetched).toEqual([]);

    nextFetch = failWith('blocked_address'); // напр. DNS → приватна адреса
    const r = await put(URL_OK);
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: 'CALENDAR_IMPORT_FAILED',
      details: { reason: 'blocked_address' },
    });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(await db.select().from(calendarImports)).toEqual([]);

    // Наявне підключення лишається, якщо нове посилання не завантажилось.
    nextFetch = async () => cal();
    expect((await put(URL_OK)).status).toBe(200);
    nextFetch = failWith('timeout');
    expect((await put(`${URL_OK}?x=1`)).status).toBe(422);
    const [row] = await db.select().from(calendarImports);
    expect(decryptUrl(importKey(deps.env), u.id, row!.urlEnc)).toBe(URL_OK);
  });

  it('PUT is rate-limited per user (each one fetches an external URL)', async () => {
    const u = await userWithAge(25, 'u');
    for (let i = 0; i < 10; i++) {
      expect((await call('put', '/api/me/calendar-import', u.cookie, { url: URL_OK })).status).toBe(
        200,
      );
    }
    const r = await call('put', '/api/me/calendar-import', u.cookie, { url: URL_OK });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('disconnect deletes the link and all imported busy data', async () => {
    const u = await userWithAge(25, 'u');
    const now = Date.now();
    nextFetch = async () => cal(ev(new Date(now + DAY), new Date(now + DAY + HOUR)));
    await connect(u.id);
    expect(await db.select().from(calendarImportBusy)).toHaveLength(1);
    expect((await call('delete', '/api/me/calendar-import', u.cookie)).status).toBe(204);
    expect(await db.select().from(calendarImports)).toEqual([]);
    expect(await db.select().from(calendarImportBusy)).toEqual([]);
    expect((await call('get', '/api/me/calendar-import', u.cookie)).body.connected).toBe(false);
    expect((await call('post', '/api/me/calendar-import/sync', u.cookie)).status).toBe(404);
  });

  it('manual sync: at most once per 5 min; a failure is visible in the status', async () => {
    const u = await userWithAge(25, 'u');
    const t0 = new Date();
    await connect(u.id, t0);
    const tooSoon = await call('post', '/api/me/calendar-import/sync', u.cookie);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.code).toBe('RATE_LIMITED');
    expect(tooSoon.body.error.details.retryAfterSec).toBeGreaterThan(0);

    nextFetch = failWith('http_gone');
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    const s = await syncCalendarImportNow(deps, u.id, t1);
    expect(s).toMatchObject({
      connected: true,
      lastError: 'http_gone',
      failures: 1,
      broken: false,
    });
    expect(s.lastSyncAt).toBe(t0.toISOString());
    // Паралельні запити — одне завантаження.
    nextFetch = async () => cal();
    fetched.length = 0;
    const t2 = new Date(t1.getTime() + 5 * 60_000);
    const both = await Promise.allSettled([1, 2].map(() => syncCalendarImportNow(deps, u.id, t2)));
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fetched).toHaveLength(1);
    expect((await getCalendarImport(deps, u.id, t2)).lastError).toBeNull();
  });

  it('server without CALENDAR_IMPORT_KEY: import is off (fail closed), nothing stored', async () => {
    const u = await userWithAge(25, 'u');
    const off: AppDeps = { ...deps, env: { ...deps.env, CALENDAR_IMPORT_KEY: undefined } };
    expect((await getCalendarImport(off, u.id)).available).toBe(false);
    await expect(putCalendarImport(off, u.id, { url: URL_OK })).rejects.toMatchObject({
      status: 503,
      code: 'CALENDAR_IMPORT_DISABLED',
    } satisfies Partial<AppError>);
    expect(fetched).toEqual([]);
    expect(await db.select().from(calendarImports)).toEqual([]);
    expect(await runCalendarImportSync(off, new Date())).toEqual({ synced: 0, failed: 0 });
  });
});

describe('calendar import limits, rotation, truncation (review fixes)', () => {
  it('fetch+parse shares a process-wide limit: extra PUTs wait in the queue', async () => {
    const people = await Promise.all(
      Array.from({ length: IMPORT_SLOTS + 2 }, (_, i) => userWithAge(25, `u${i}`)),
    );
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    nextFetch = async () => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return cal();
    };
    const puts = people.map((p) =>
      call('put', '/api/me/calendar-import', p.cookie, { url: URL_OK }),
    );
    const started = puts.map((r) => r.then((x) => x)); // supertest запускає запит на then
    await vi.waitFor(() => expect(active).toBe(IMPORT_SLOTS), { timeout: 5_000 });
    expect(importSlots.queued).toBe(2);
    release();
    const res = await Promise.all(started);
    expect(res.map((r) => r.status)).toEqual(people.map(() => 200));
    expect(peak).toBe(IMPORT_SLOTS);
    expect(importSlots.inUse).toBe(0);
  });

  it('key rotation: the previous key still decrypts; the next success re-encrypts', async () => {
    const u = await userWithAge(25, 'u');
    const t0 = Date.now();
    await connect(u.id, new Date(t0));
    const oldKey = deps.env.CALENDAR_IMPORT_KEY!;
    const newKey = Buffer.alloc(32, 7).toString('base64');
    const rotated: AppDeps = {
      ...deps,
      env: { ...deps.env, CALENDAR_IMPORT_KEY: newKey, CALENDAR_IMPORT_KEY_PREVIOUS: oldKey },
    };
    fetched.length = 0;
    expect(await runCalendarImportSync(rotated, new Date(t0 + 3 * HOUR))).toEqual({
      synced: 1,
      failed: 0,
    });
    expect(fetched).toEqual([URL_OK]);
    const [row] = await db.select().from(calendarImports);
    expect(decryptUrl(Buffer.from(newKey, 'base64'), u.id, row!.urlEnc)).toBe(URL_OK);
    // Без попереднього ключа старий шифротекст не прочитати — помилка, але без витоку.
    const [again] = await db.select().from(calendarImports);
    await db.update(calendarImports).set({ urlEnc: encryptUrl(importKey(deps.env), u.id, URL_OK) });
    const noPrev: AppDeps = { ...deps, env: { ...deps.env, CALENDAR_IMPORT_KEY: newKey } };
    expect(await runCalendarImportSync(noPrev, new Date(t0 + 6 * HOUR))).toEqual({
      synced: 0,
      failed: 1,
    });
    expect((await getCalendarImport(deps, u.id)).lastError).toBe('invalid_url');
    expect(again).toBeTruthy();
  });

  it('status exposes «truncated» when expansion limits skipped events', async () => {
    const u = await userWithAge(25, 'u');
    const t0 = new Date();
    const hourly = (uid: string) =>
      [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART:${ics(t0)}`,
        'DURATION:PT10M',
        'RRULE:FREQ=HOURLY',
        'END:VEVENT',
      ].join('\r\n');
    nextFetch = async () => cal(hourly('a'), hourly('b'));
    const s = await connect(u.id, t0);
    expect(s).toMatchObject({ truncated: true, eventsCount: 2000 });
    nextFetch = async () => cal();
    const s2 = await syncCalendarImportNow(deps, u.id, new Date(t0.getTime() + 5 * 60_000));
    expect(s2.truncated).toBe(false);
  });
});

describe('calendar import job', () => {
  it('refreshes every 3 h; 5 failures in a row → broken once (data dropped, one notification)', async () => {
    const u = await userWithAge(25, 'u');
    const other = await userWithAge(25, 'o');
    const t0 = Date.now();
    nextFetch = async () => cal(ev(new Date(t0 + DAY), new Date(t0 + DAY + HOUR)));
    await connect(u.id, new Date(t0));
    await connect(other.id, new Date(t0));
    fetched.length = 0;

    // Ще не минуло 3 год — нічого.
    expect(await runCalendarImportSync(deps, new Date(t0 + 2 * HOUR))).toEqual({
      synced: 0,
      failed: 0,
    });
    expect(fetched).toEqual([]);

    // Новий вміст замінює старий атомарно.
    nextFetch = async () => cal(ev(new Date(t0 + 2 * DAY), new Date(t0 + 2 * DAY + HOUR)));
    let t = t0 + 3 * HOUR;
    expect(await runCalendarImportSync(deps, new Date(t))).toEqual({ synced: 2, failed: 0 });
    const rows = await db
      .select()
      .from(calendarImportBusy)
      .where(eq(calendarImportBusy.userId, u.id));
    expect(rows.map((r) => r.startsAt.getTime())).toEqual([
      Math.floor((t0 + 2 * DAY) / 1000) * 1000,
    ]);

    nextFetch = failWith('timeout');
    for (let i = 1; i <= CALENDAR_IMPORT_MAX_FAILURES; i++) {
      t += 3 * HOUR;
      expect(await runCalendarImportSync(deps, new Date(t))).toEqual({ synced: 0, failed: 2 });
      const s = await getCalendarImport(deps, u.id, new Date(t));
      expect(s).toMatchObject({
        failures: i,
        lastError: 'timeout',
        broken: i === CALENDAR_IMPORT_MAX_FAILURES,
      });
    }
    expect(logs.some((l) => l.includes(`user ${u.id} sync failed (timeout)`))).toBe(true);
    // Зламано: дані видалено, підбір більше не вважає це календарем, автооновлення зупинено.
    expect(await db.select().from(calendarImportBusy)).toEqual([]);
    fetched.length = 0;
    expect(await runCalendarImportSync(deps, new Date(t + 10 * HOUR))).toEqual({
      synced: 0,
      failed: 0,
    });
    expect(fetched).toEqual([]);
    const sent = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'calendar.import_broken'));
    expect(sent.map((n) => n.userId).sort()).toEqual([u.id, other.id].sort());
    expect(sent[0]).toMatchObject({ category: 'schedule' });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(notificationLink('calendar.import_broken', sent[0]!.payload)).toBe('/calendar');

    // Ручне оновлення невдале — без повторного сповіщення; повторне збереження — знову працює.
    await syncCalendarImportNow(deps, u.id, new Date(t + 11 * HOUR));
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, u.id)),
    ).toHaveLength(1);
    nextFetch = async () => cal();
    const re = await connect(u.id, new Date(t + 12 * HOUR));
    expect(re).toMatchObject({ broken: false, failures: 0, lastError: null });
  });

  it('a result for a link that was replaced or disconnected meanwhile is discarded', async () => {
    const u = await userWithAge(25, 'u');
    const t0 = Date.now();
    await connect(u.id, new Date(t0));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    nextFetch = async () => {
      await gate;
      return cal(ev(new Date(t0 + DAY), new Date(t0 + DAY + HOUR)));
    };
    const run = runCalendarImportSync(deps, new Date(t0 + 3 * HOUR));
    await new Promise((r) => setTimeout(r, 50));
    await call('delete', '/api/me/calendar-import', u.cookie);
    release();
    await run;
    expect(await db.select().from(calendarImports)).toEqual([]);
    expect(await db.select().from(calendarImportBusy)).toEqual([]);
  });
});

describe('imported busy in the finder and the reminder', () => {
  const kyivAt = (daysAhead: number, hour = 19) => {
    const z = toZoned(new Date(Date.now() + daysAhead * DAY), KYIV);
    return {
      start: zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, KYIV),
      z,
    };
  };

  it('a member with only an imported calendar is «can» except where busy', async () => {
    const gm = await userWithAge(30, 'gm');
    const p = await userWithAge(25, 'p');
    const first = kyivAt(2);
    const W = first.z.weekday as Weekday;
    const gameId = await createGame(
      gm.cookie,
      { startsAt: first.start.toISOString(), weekdays: [W] },
      true,
    );
    const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, {
      warningsAccepted: true,
      answers: [],
    });
    expect((await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie)).status).toBe(
      200,
    );
    await db
      .insert(availabilitySlots)
      .values({ userId: gm.id, weekday: W, startMin: 19 * 60, endMin: 23 * 60 });
    const NOW = zonedToUtc({ ...kyivAt(1).z, hour: 0, minute: 0 }, KYIV);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const window = { from: NOW, to: new Date(NOW.getTime() + 28 * DAY) };

    const before = await computeCommonTimes(deps, game!, window, { now: NOW });
    const st = (dto: typeof before) =>
      dto.regular
        .find((c) => c.weekday === W && c.startMin === 19 * 60)!
        .statuses.find((s) => s.userId === p.id)!;
    expect(before.participants.find((x) => x.userId === p.id)!.hasCalendar).toBe(false);
    expect(st(before)).toMatchObject({ status: 'unknown', weeksCan: 0 });

    // Подія в перший тиждень 19:00–20:00 — лише цей тиждень «не може».
    nextFetch = async () => cal(ev(first.start, new Date(first.start.getTime() + HOUR)));
    await connect(p.id, NOW);
    const after = await computeCommonTimes(deps, game!, window, { now: NOW });
    expect(after.participants.find((x) => x.userId === p.id)!.hasCalendar).toBe(true);
    expect(st(after)).toMatchObject({ status: 'can', weeksCan: 3 });
    const one = after.oneOff.find((c) => c.startsAt === first.start.toISOString());
    if (one) expect(one.statuses.find((s) => s.userId === p.id)!.status).toBe('cannot');
  });

  it('an import without weekly slots still gets the reminder, with the «usual hours» text', async () => {
    const gm = await userWithAge(30, 'gm');
    const p = await userWithAge(25, 'p');
    const q = await userWithAge(25, 'q');
    const first = kyivAt(2);
    const gameId = await createGame(
      gm.cookie,
      { startsAt: first.start.toISOString(), weekdays: [first.z.weekday] },
      true,
    );
    for (const u of [p, q]) {
      const a = await call('post', `/api/games/${gameId}/applications`, u.cookie, {
        warningsAccepted: true,
        answers: [],
      });
      expect((await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie)).status).toBe(
        200,
      );
    }
    await connect(p.id);
    const sent = await runCalendarReminders(deps, new Date(Date.now() + 25 * HOUR));
    expect(sent.sort()).toEqual([p.id, q.id].sort());
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'calendar.empty'));
    const byUser = new Map(rows.map((r) => [r.userId, r.payload]));
    expect(byUser.get(p.id)).toMatchObject({ gameId, hasImport: true });
    expect(byUser.get(q.id)).not.toHaveProperty('hasImport');
  });
});
