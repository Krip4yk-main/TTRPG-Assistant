import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  notificationPrefs,
  notifications,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { runDaily } from '../../src/jobs/daily.js';
import { dispatchEvents } from '../../src/notifications/dispatcher.js';
import { createNotification } from '../../src/notifications/notifications.service.js';
import {
  claimOutbox,
  enqueueTelegram,
  markOutboxFailed,
  markOutboxSent,
  purgeTelegramOutbox,
} from '../../src/notifications/telegram-outbox.js';
import { deleteAccount, unlinkIdentity } from '../../src/users/users.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);
const KEY = 'test-internal-key-0123456789abcdefghij';

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const SEC = 1000;
const APPLY = { warningsAccepted: true, answers: [] as string[] };

async function linkTelegram(userId: number, tgId: string): Promise<void> {
  await db.insert(authIdentities).values({ userId, provider: 'telegram', subject: tgId });
}

async function outbox() {
  return db.select().from(telegramOutbox).orderBy(telegramOutbox.id);
}

/** Сповіщення-нагадування для користувача (+ рядок outbox, якщо прив'язано Telegram). */
async function reminder(userId: number, sessionId = 5) {
  return db.transaction((tx) =>
    createNotification(deps, tx, {
      userId,
      type: 'session.reminder',
      category: 'reminders',
      params: { gameId: 1, gameTitle: 'Гра', sessionId, startsAt: new Date().toISOString() },
      entityType: 'session',
      entityId: sessionId,
    }),
  );
}

describe('enqueue (Review Focus 5)', () => {
  it('application.created → GM with Telegram gets a row with approve/reject buttons', async () => {
    const gm = await userWithAge(30, 'Майстер');
    await linkTelegram(gm.id, '7001');
    const p = await userWithAge(25, 'Гравець');
    const gameId = await createGame(gm.cookie, {}, true);
    const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
    expect(a.status).toBe(201);
    await dispatchEvents(deps);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, gm.id));
    expect(rows[0]).toMatchObject({
      notificationId: n!.id,
      userId: gm.id,
      chatId: '7001',
      kind: 'application.created',
      status: 'pending',
      attempts: 0,
      buttons: [
        { action: 'approve', applicationId: a.body.id },
        { action: 'reject', applicationId: a.body.id },
      ],
    });
    expect(rows[0]!.params).toMatchObject({ gameId, gameTitle: 'Прокляття Страда' });
  });

  it('no Telegram identity → notification but no outbox row', async () => {
    const gm = await userWithAge(30, 'Майстер');
    const p = await userWithAge(25, 'Гравець');
    const gameId = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
    await dispatchEvents(deps);
    expect(await db.select().from(notifications)).toHaveLength(1);
    expect(await outbox()).toHaveLength(0);
  });

  it('disabled category → no row; other categories still go', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7002');
    await db.insert(notificationPrefs).values({
      userId: u.id,
      telegram: {
        applications: true,
        members: true,
        sessions: true,
        reminders: false,
        games: true,
      },
      reminderOffsets: [60],
    });
    await reminder(u.id);
    expect(await outbox()).toHaveLength(0);
    const gm = await userWithAge(30, 'Майстер');
    await linkTelegram(gm.id, '7003');
    await db.insert(notificationPrefs).values({
      userId: gm.id,
      telegram: {
        applications: false,
        members: true,
        sessions: true,
        reminders: true,
        games: true,
      },
      reminderOffsets: [60],
    });
    const p = await userWithAge(25, 'Гравець');
    const gameId = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
    await dispatchEvents(deps);
    expect(await outbox()).toHaveLength(0);
    await reminder(gm.id);
    expect(await outbox()).toHaveLength(1);
  });

  it('session.reminder → RSVP buttons; repeat enqueue is a no-op', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7004');
    const n = await reminder(u.id, 42);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.buttons).toEqual([
      { action: 'rsvp', sessionId: 42, value: 'going' },
      { action: 'rsvp', sessionId: 42, value: 'not_going' },
    ]);
    expect(await enqueueTelegram(db, [n])).toBe(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('session.reminder to the game GM carries no RSVP buttons', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    await linkTelegram(gm.id, '7006');
    await db.transaction((tx) =>
      createNotification(deps, tx, {
        userId: gm.id,
        type: 'session.reminder',
        category: 'reminders',
        params: { gameId, gameTitle: 'Гра', sessionId: 9, startsAt: new Date().toISOString() },
        entityType: 'session',
        entityId: 9,
      }),
    );
    expect((await outbox())[0]!.buttons).toBeNull();
  });

  it('other types carry no buttons', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7005');
    await db.transaction((tx) =>
      createNotification(deps, tx, {
        userId: u.id,
        type: 'game.started',
        category: 'games',
        params: { gameId: 1, gameTitle: 'Гра' },
        entityType: 'game',
        entityId: 1,
      }),
    );
    expect((await outbox())[0]!.buttons).toBeNull();
  });

  it('an outbox failure rolls back the notification', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, 'x'.repeat(40)); // > varchar(32) → помилка вставки в outbox
    await expect(reminder(u.id)).rejects.toThrow();
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});

/** Власник чату (прив'язаний Telegram `chat`); створюється за потреби. */
async function chatOwner(chat: string): Promise<number> {
  const [ident] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, 'telegram'), eq(authIdentities.subject, chat)));
  if (ident) return ident.userId;
  const u = await createUser(db);
  await linkTelegram(u.id, chat);
  return u.id;
}

/** N рядків outbox власника чату `chat` (його Telegram прив'язано). */
async function seed(n: number, chat = '900') {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = { id: await chatOwner(chat) };
    const [res] = await db
      .insert(notifications)
      .values({
        userId: u.id,
        type: 'game.started',
        category: 'games',
        payload: { gameId: 1 },
      })
      .$returningId();
    const [o] = await db
      .insert(telegramOutbox)
      .values({
        notificationId: res!.id,
        userId: u.id,
        chatId: chat,
        kind: 'game.started',
        params: { gameId: 1, gameTitle: 'Гра' },
        nextTryAt: new Date(Date.now() - 1000),
      })
      .$returningId();
    ids.push(o!.id);
  }
  return ids;
}

const row = async (id: number) =>
  (await db.select().from(telegramOutbox).where(eq(telegramOutbox.id, id)))[0]!;

describe('claim', () => {
  it('two concurrent claims never return the same row', async () => {
    await seed(10);
    const [a, b] = await Promise.all([
      claimOutbox(deps, { limit: 6 }),
      claimOutbox(deps, { limit: 6 }),
    ]);
    // SKIP LOCKED: другий виклик пропускає рядки першого (скільки саме він захопить — залежить
    // від плану запиту), але жоден рядок не видається двічі; решту забирає наступний виклик.
    const rest = await claimOutbox(deps, { limit: 50 });
    const ids = [...a, ...b, ...rest].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(10);
    expect(await claimOutbox(deps, {})).toEqual([]);
  });

  it('returns item fields, skips future rows, reclaims expired locks', async () => {
    const [id] = await seed(1);
    const [future] = await seed(1);
    await db
      .update(telegramOutbox)
      .set({ nextTryAt: new Date(Date.now() + 3600 * SEC) })
      .where(eq(telegramOutbox.id, future!));
    const now = new Date();
    const [item] = await claimOutbox(deps, {}, now);
    expect(item).toEqual({
      id,
      chatId: '900',
      kind: 'game.started',
      params: { gameId: 1, gameTitle: 'Гра' },
      buttons: null,
      attempts: 1,
      timeZone: null,
      silent: false,
    });
    expect((await row(id!)).lockedUntil!.getTime()).toBe(now.getTime() + 120 * SEC);
    expect((await row(id!)).attempts).toBe(1);
    expect(await claimOutbox(deps, {}, new Date(now.getTime() + 119 * SEC))).toEqual([]);
    const again = await claimOutbox(deps, {}, new Date(now.getTime() + 121 * SEC));
    expect(again.map((i) => i.id)).toEqual([id]);
  });

  it('rows whose chat is no longer the user Telegram are failed "unlinked", not claimed', async () => {
    const [kept, relinked, gone] = [
      ...(await seed(1, '910')),
      ...(await seed(1, '911')),
      ...(await seed(1, '912')),
    ];
    // Перев'язано на інший чат / відв'язано без скасування черги.
    const owner = async (id: number) => (await row(id)).userId;
    await db
      .update(authIdentities)
      .set({ subject: '919' })
      .where(eq(authIdentities.userId, await owner(relinked!)));
    await db.delete(authIdentities).where(eq(authIdentities.userId, await owner(gone!)));
    const items = await claimOutbox(deps, {});
    expect(items.map((i) => i.id)).toEqual([kept]);
    for (const id of [relinked!, gone!]) {
      expect(await row(id)).toMatchObject({ status: 'failed', lastError: 'unlinked', attempts: 0 });
    }
    expect((await row(kept!)).attempts).toBe(1);
  });

  it('sent rows are not claimed again', async () => {
    const [id] = await seed(1);
    await claimOutbox(deps, {});
    await markOutboxSent(deps, id!);
    const r = await row(id!);
    expect(r.status).toBe('sent');
    expect(r.lockedUntil).toBeNull();
    expect(await claimOutbox(deps, {}, new Date(Date.now() + 600 * SEC))).toEqual([]);
  });
});

describe('failed', () => {
  it('retryable: claims count as attempts; exponential backoff, then failed on the 5th', async () => {
    const [id] = await seed(1);
    let now = new Date();
    for (let n = 1; n <= 4; n++) {
      expect((await claimOutbox(deps, {}, now)).map((i) => i.attempts)).toEqual([n]);
      await markOutboxFailed(deps, id!, { retryable: true, error: `e${n}` }, now);
      const r = await row(id!);
      expect(r.status).toBe('pending');
      expect(r.attempts).toBe(n);
      expect(r.lastError).toBe(`e${n}`);
      expect(r.lockedUntil).toBeNull();
      expect(r.nextTryAt.getTime()).toBe(now.getTime() + 30 * SEC * 2 ** (n - 1));
      expect(await claimOutbox(deps, {}, new Date(r.nextTryAt.getTime() - 1))).toEqual([]);
      now = new Date(r.nextTryAt.getTime());
    }
    expect((await claimOutbox(deps, {}, now)).map((i) => i.attempts)).toEqual([5]);
    await markOutboxFailed(deps, id!, { retryable: true }, now);
    const r = await row(id!);
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(5);
  });

  it('a row claimed 5 times without any report → failed "lock expired"', async () => {
    const [id] = await seed(1);
    let now = new Date();
    for (let n = 1; n <= 5; n++) {
      expect((await claimOutbox(deps, {}, now)).map((i) => i.id)).toEqual([id]);
      now = new Date(now.getTime() + 121 * SEC); // лок сплив — бот «упав»
    }
    expect(await claimOutbox(deps, {}, now)).toEqual([]);
    expect(await row(id!)).toMatchObject({
      status: 'failed',
      attempts: 5,
      lastError: 'lock expired',
      lockedUntil: null,
    });
  });

  it('pending rows older than 24h are failed "stale" and not sent', async () => {
    const [old, fresh] = await seed(2);
    await db
      .update(telegramOutbox)
      .set({ createdAt: new Date(Date.now() - 25 * 3600 * SEC) })
      .where(eq(telegramOutbox.id, old!));
    const items = await claimOutbox(deps, {});
    expect(items.map((i) => i.id)).toEqual([fresh]);
    expect(await row(old!)).toMatchObject({ status: 'failed', lastError: 'stale' });
  });

  it('rateLimited: the attempt is not counted, retry not before retryAfterSec', async () => {
    const [id] = await seed(1);
    const now = new Date();
    await claimOutbox(deps, {}, now);
    expect((await row(id!)).attempts).toBe(1);
    await markOutboxFailed(
      deps,
      id!,
      { retryable: true, rateLimited: true, retryAfterSec: 7, error: '429' },
      now,
    );
    const r = await row(id!);
    expect(r).toMatchObject({ status: 'pending', attempts: 0, lockedUntil: null });
    expect(r.nextTryAt.getTime()).toBe(now.getTime() + 7 * SEC);
    // Багато 429 поспіль не вичерпують спроби.
    let t = r.nextTryAt;
    for (let n = 0; n < 6; n++) {
      expect(await claimOutbox(deps, {}, t)).toHaveLength(1);
      await markOutboxFailed(
        deps,
        id!,
        { retryable: true, rateLimited: true, retryAfterSec: 1 },
        t,
      );
      t = (await row(id!)).nextTryAt;
    }
    expect(await row(id!)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('respects retryAfterSec when longer than the backoff', async () => {
    const [id] = await seed(1);
    const now = new Date();
    await markOutboxFailed(deps, id!, { retryable: true, retryAfterSec: 300 }, now);
    expect((await row(id!)).nextTryAt.getTime()).toBe(now.getTime() + 300 * SEC);
  });

  it('non-retryable → failed at once; a late sent/failed does not resurrect it', async () => {
    const [id] = await seed(1);
    await claimOutbox(deps, {});
    await markOutboxFailed(deps, id!, { retryable: false, error: '400: bad' });
    expect(await row(id!)).toMatchObject({ status: 'failed', attempts: 1, lastError: '400: bad' });
    await markOutboxFailed(deps, id!, { retryable: true });
    expect((await row(id!)).status).toBe('failed');
  });

  it('chatUnreachable fails the other idle rows of that chat only', async () => {
    const [first, second, inFlight] = await seed(3, '555');
    const [other] = await seed(1, '556');
    // inFlight — уже виданий боту (живий лок): він отримає власну відповідь Telegram.
    await db
      .update(telegramOutbox)
      .set({ lockedUntil: new Date(Date.now() + 60 * SEC) })
      .where(eq(telegramOutbox.id, inFlight!));
    await markOutboxFailed(deps, first!, {
      retryable: false,
      chatUnreachable: true,
      error: '403: Forbidden: bot was blocked by the user',
    });
    expect((await row(first!)).status).toBe('failed');
    expect(await row(second!)).toMatchObject({ status: 'failed', lastError: 'chat unreachable' });
    expect((await row(inFlight!)).status).toBe('pending');
    expect((await row(other!)).status).toBe('pending');
  });

  it('truncates long errors to 255 chars', async () => {
    const [id] = await seed(1);
    await markOutboxFailed(deps, id!, { retryable: true, error: 'x'.repeat(900) });
    expect((await row(id!)).lastError).toHaveLength(255);
  });
});

describe('internal API', () => {
  const post = (path: string, body: object = {}, key: string | null = KEY) => {
    const r = request(app).post(`/api/internal/telegram/outbox${path}`);
    if (key !== null) r.set('X-Internal-Key', key);
    return r.send(body);
  };

  it('requires the internal key', async () => {
    const [id] = await seed(1);
    for (const path of ['/claim', `/${id}/sent`, `/${id}/failed`]) {
      expect((await post(path, { retryable: true }, null)).status).toBe(401);
      expect((await post(path, { retryable: true }, 'wrong-key')).status).toBe(401);
    }
    expect((await row(id!)).lockedUntil).toBeNull();
    expect((await row(id!)).status).toBe('pending');
  });

  it('claim → sent / failed round trip', async () => {
    const [a, b] = await seed(2);
    const c = await post('/claim', { limit: 5 });
    expect(c.status).toBe(200);
    expect(c.body.items.map((i: { id: number }) => i.id)).toEqual([a, b]);
    expect((await post(`/${a}/sent`)).status).toBe(204);
    expect((await post(`/${b}/failed`, { retryable: true, error: 'net' })).status).toBe(204);
    expect((await row(a!)).status).toBe('sent');
    expect(await row(b!)).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('validates input', async () => {
    const [id] = await seed(1);
    expect((await post('/claim', { limit: 51 })).status).toBe(400);
    expect((await post('/claim', { limit: 0 })).status).toBe(400);
    expect((await post(`/${id}/failed`, {})).status).toBe(400);
    expect((await post(`/${id}/failed`, { retryable: 'yes' })).status).toBe(400);
    expect((await post('/abc/sent')).status).toBe(400);
    expect((await post('/999999/sent')).status).toBe(404);
    expect((await post('/999999/failed', { retryable: false })).status).toBe(404);
  });
});

describe('recipient time zone', () => {
  it('is copied from users.timezone and handed to the bot', async () => {
    const u = await createUser(db, { timezone: 'America/New_York' });
    await linkTelegram(u.id, '7101');
    await reminder(u.id);
    const [r] = await outbox();
    expect(r!.timeZone).toBe('America/New_York');
    const [item] = await claimOutbox(deps, {});
    expect(item!.timeZone).toBe('America/New_York');
  });
});

describe('quiet hours (Task 5)', () => {
  const MIN = 60 * SEC;
  type Quiet = { enabled: boolean; start: string; end: string };

  /** Одержувач із Telegram у поясі `tz`; `quiet` — збережені тихі години (без — за замовчуванням). */
  async function recipient(tz = 'Europe/Kyiv', quiet?: Quiet) {
    const u = await createUser(db, { timezone: tz });
    await linkTelegram(u.id, String(8000 + u.id));
    if (quiet) {
      await db.insert(notificationPrefs).values({
        userId: u.id,
        telegram: {},
        reminderOffsets: [60],
        quietHoursEnabled: quiet.enabled,
        quietHoursStart: quiet.start,
        quietHoursEnd: quiet.end,
      });
    }
    return u.id;
  }

  /** Ставить у чергу сповіщення `type` у момент `now`; повертає рядок outbox. */
  async function enqueueAt(
    userId: number,
    now: Date,
    type = 'game.started',
    params: Record<string, unknown> = { gameId: 1, gameTitle: 'Гра' },
  ) {
    const category =
      type === 'session.reminder'
        ? 'reminders'
        : type.startsWith('session.')
          ? 'sessions'
          : 'games';
    const [res] = await db
      .insert(notifications)
      .values({ userId, type, category, payload: params })
      .$returningId();
    expect(
      await enqueueTelegram(db, [{ id: res!.id, userId, type, category, payload: params }], now),
    ).toBe(1);
    const [r] = await db
      .select()
      .from(telegramOutbox)
      .where(eq(telegramOutbox.notificationId, res!.id));
    return r!;
  }

  const at = (iso: string) => new Date(iso);
  /** «Одразу»: `next_try_at` — сам момент постановки, не відкладено. */
  const expectImmediate = (r: { nextTryAt: Date; silent: boolean }, now: Date, silent = false) => {
    expect(r.nextTryAt.toISOString()).toBe(now.toISOString());
    expect(r.silent).toBe(silent);
  };

  it('23:30 Kyiv → 08:00 Kyiv next day', async () => {
    const u = await recipient();
    const r = await enqueueAt(u, at('2026-12-01T21:30:00Z'));
    expect(r.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    expect(r.silent).toBe(false);
  });

  it('07:00 Kyiv → 08:00 the same day; exactly 23:00 is quiet, exactly 08:00 is not', async () => {
    const u = await recipient();
    expect((await enqueueAt(u, at('2026-12-02T05:00:00Z'))).nextTryAt.toISOString()).toBe(
      '2026-12-02T06:00:00.000Z',
    );
    expect((await enqueueAt(u, at('2026-12-01T21:00:00Z'))).nextTryAt.toISOString()).toBe(
      '2026-12-02T06:00:00.000Z',
    );
    const eight = at('2026-12-02T06:00:00Z');
    expectImmediate(await enqueueAt(u, eight), eight);
  });

  it('12:00 Kyiv → at once', async () => {
    const u = await recipient();
    const noon = at('2026-12-02T10:00:00Z');
    expectImmediate(await enqueueAt(u, noon), noon);
  });

  it('uses the recipient zone: Warsaw vs Kyiv at the same instant', async () => {
    const warsaw = await recipient('Europe/Warsaw');
    const kyiv = await recipient('Europe/Kyiv');
    const now = at('2026-12-01T22:30:00Z'); // 23:30 Варшава, 00:30 Київ
    expect((await enqueueAt(warsaw, now)).nextTryAt.toISOString()).toBe('2026-12-02T07:00:00.000Z');
    expect((await enqueueAt(kyiv, now)).nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    // 21:30 Варшава (22:30 Київ) — у Варшаві ще не тихо.
    const evening = at('2026-12-01T20:30:00Z');
    expectImmediate(await enqueueAt(warsaw, evening), evening);
  });

  it('DST nights: end is 08:00 local after the spring and autumn switch', async () => {
    const u = await recipient();
    // 27→28.03.2027: 23:30 EET (+2) → 08:00 EEST (+3).
    expect((await enqueueAt(u, at('2027-03-27T21:30:00Z'))).nextTryAt.toISOString()).toBe(
      '2027-03-28T05:00:00.000Z',
    );
    // 24→25.10.2026: 23:30 EEST (+3) → 08:00 EET (+2).
    expect((await enqueueAt(u, at('2026-10-24T20:30:00Z'))).nextTryAt.toISOString()).toBe(
      '2026-10-25T06:00:00.000Z',
    );
  });

  it('an end inside the spring gap moves forward like zonedToUtc (03:30 → 04:30 EEST)', async () => {
    const u = await recipient('Europe/Kyiv', { enabled: true, start: '01:00', end: '03:30' });
    // 28.03.2027 02:30 EET = 00:30Z; 03:30 не існує → 04:30 EEST = 01:30Z.
    expect((await enqueueAt(u, at('2027-03-28T00:30:00Z'))).nextTryAt.toISOString()).toBe(
      '2027-03-28T01:30:00.000Z',
    );
  });

  it('an unknown stored zone falls back to Kyiv instead of failing the notification', async () => {
    const u = await recipient('Not/AZone');
    expect((await enqueueAt(u, at('2026-12-01T21:30:00Z'))).nextTryAt.toISOString()).toBe(
      '2026-12-02T06:00:00.000Z',
    );
  });

  it('a daytime interval (13:00–15:00) and a disabled one', async () => {
    const day = await recipient('Europe/Kyiv', { enabled: true, start: '13:00', end: '15:00' });
    expect((await enqueueAt(day, at('2026-12-02T12:00:00Z'))).nextTryAt.toISOString()).toBe(
      '2026-12-02T13:00:00.000Z',
    );
    const night = at('2026-12-01T21:30:00Z');
    expectImmediate(await enqueueAt(day, night), night);
    const off = await recipient('Europe/Kyiv', { enabled: false, start: '23:00', end: '08:00' });
    expectImmediate(await enqueueAt(off, night), night);
  });

  it('urgent at 01:00: reminder for a session ≤ 2h away goes at once, silently', async () => {
    const u = await recipient();
    const now = at('2026-12-01T23:00:00Z'); // 01:00 Київ
    const soon = new Date(now.getTime() + 90 * MIN).toISOString();
    const later = new Date(now.getTime() + 3 * 60 * MIN).toISOString();
    expectImmediate(
      await enqueueAt(u, now, 'session.reminder', { gameId: 1, sessionId: 1, startsAt: soon }),
      now,
      true,
    );
    // За 3 год (04:00 Київ) — ще до кінця тихих годин: теж одразу, без звуку.
    expectImmediate(
      await enqueueAt(u, now, 'session.reminder', { gameId: 1, sessionId: 2, startsAt: later }),
      now,
      true,
    );
    // Сесія після кінця тихих годин (09:00 Київ) — не термінове: зранку, зі звуком.
    const r = await enqueueAt(u, now, 'session.reminder', {
      gameId: 1,
      sessionId: 3,
      startsAt: '2026-12-02T07:00:00.000Z',
    });
    expect(r.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    expect(r.silent).toBe(false);
  });

  it('X-Card is always urgent: at 01:00 goes at once (silently), even without startsAt', async () => {
    const u = await recipient();
    const now = at('2026-12-01T23:00:00Z'); // 01:00 Київ
    expectImmediate(
      await enqueueAt(u, now, 'session.x_card', { gameId: 1, sessionId: 1, gameTitle: 'Гра' }),
      now,
      true,
    );
    // Ще одна через 5 хв — окремий рядок, теж одразу (без групування й дедуплікації).
    const later = new Date(now.getTime() + 5 * MIN);
    expectImmediate(
      await enqueueAt(u, later, 'session.x_card', { gameId: 1, sessionId: 1, gameTitle: 'Гра' }),
      later,
      true,
    );
    // Удень — одразу, зі звуком.
    const noon = at('2026-12-02T10:00:00Z');
    expectImmediate(await enqueueAt(u, noon, 'session.x_card', { gameId: 1, sessionId: 1 }), noon);
  });

  it('urgent at 23:10: a session before the quiet end is not held past itself', async () => {
    const u = await recipient();
    const now = at('2026-12-01T21:10:00Z'); // 23:10 Київ, кінець тихих — 08:00 (06:00Z)
    const week = '2026-12-08T17:00:00.000Z';
    // Перенесення сесії о 06:30 Київ на наступний тиждень — одразу, без звуку.
    expectImmediate(
      await enqueueAt(u, now, 'session.rescheduled', {
        gameId: 1,
        from: '2026-12-02T04:30:00.000Z',
        startsAt: week,
      }),
      now,
      true,
    );
    // Скасування сесії о 02:00 Київ — одразу, без звуку.
    expectImmediate(
      await enqueueAt(u, now, 'session.cancelled', {
        gameId: 1,
        startsAt: '2026-12-02T00:00:00.000Z',
      }),
      now,
      true,
    );
    // Нагадування (не термінове зміщення) про сесію о 07:00 Київ — одразу, без звуку.
    expectImmediate(
      await enqueueAt(u, now, 'session.reminder', {
        gameId: 1,
        sessionId: 1,
        startsAt: '2026-12-02T05:00:00.000Z',
      }),
      now,
      true,
    );
    // Перенесення сесії наступного тижня — як і було, зранку о 08:00.
    const held = await enqueueAt(u, now, 'session.rescheduled', {
      gameId: 1,
      from: week,
      startsAt: '2026-12-09T17:00:00.000Z',
    });
    expect(held.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    expect(held.silent).toBe(false);
  });

  it('urgent: reschedule with the old or new date ≤ 2h, cancellation ≤ 2h', async () => {
    const u = await recipient();
    const now = at('2026-12-01T23:00:00Z');
    const soon = new Date(now.getTime() + 60 * MIN).toISOString();
    const week = new Date(now.getTime() + 7 * 24 * 60 * MIN).toISOString();
    expectImmediate(
      await enqueueAt(u, now, 'session.rescheduled', { gameId: 1, from: soon, startsAt: week }),
      now,
      true,
    );
    expectImmediate(
      await enqueueAt(u, now, 'session.rescheduled', { gameId: 1, from: week, startsAt: soon }),
      now,
      true,
    );
    expectImmediate(
      await enqueueAt(u, now, 'session.cancelled', { gameId: 1, startsAt: soon }),
      now,
      true,
    );
    const far = await enqueueAt(u, now, 'session.cancelled', { gameId: 1, startsAt: week });
    expect(far.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    // Інший тип із близьким startsAt — не термінове.
    const other = await enqueueAt(u, now, 'session.created', { gameId: 1, startsAt: soon });
    expect(other.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
  });

  it('urgent outside quiet hours / with quiet hours off → normal sound', async () => {
    const u = await recipient();
    const noon = at('2026-12-02T10:00:00Z');
    const soon = new Date(noon.getTime() + 30 * MIN).toISOString();
    expectImmediate(
      await enqueueAt(u, noon, 'session.reminder', { gameId: 1, startsAt: soon }),
      noon,
    );
    const off = await recipient('Europe/Kyiv', { enabled: false, start: '23:00', end: '08:00' });
    const night = at('2026-12-01T23:00:00Z');
    const nightSoon = new Date(night.getTime() + 30 * MIN).toISOString();
    expectImmediate(
      await enqueueAt(off, night, 'session.reminder', { gameId: 1, startsAt: nightSoon }),
      night,
    );
  });

  it('claim hands silent to the bot; postponed rows are not claimed before the end', async () => {
    const u = await recipient();
    const now = at('2026-12-01T23:00:00Z');
    const soon = new Date(now.getTime() + 30 * MIN).toISOString();
    const urgent = await enqueueAt(u, now, 'session.reminder', { gameId: 1, startsAt: soon });
    const later = await enqueueAt(u, now);
    expect(later.nextTryAt.toISOString()).toBe('2026-12-02T06:00:00.000Z');
    // Вік рядка (для «stale») — від моменту постановки.
    await db.update(telegramOutbox).set({ createdAt: now });
    const claimed = await claimOutbox(deps, {}, now);
    expect(claimed.map((i) => [i.id, i.silent])).toEqual([[urgent.id, true]]);
    await markOutboxSent(deps, urgent.id);
    expect(await claimOutbox(deps, {}, new Date('2026-12-02T05:59:00Z'))).toEqual([]);
    // Відкладений рядок видається з кінцем тихих годин.
    const [morning] = await claimOutbox(deps, {}, new Date('2026-12-02T06:00:00Z'));
    expect(morning).toMatchObject({ id: later.id, silent: false });
  });
});

describe('cancel pending rows on unlink / account deletion', () => {
  it('unlinking Telegram fails that user pending rows ("unlinked"), not others', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7201');
    await db.insert(authIdentities).values({ userId: u.id, provider: 'google', subject: 'g-1' });
    const other = await createUser(db);
    await linkTelegram(other.id, '7202');
    await reminder(u.id);
    await reminder(other.id);
    await unlinkIdentity(deps, u.id, 'telegram');
    const rows = await outbox();
    expect(rows.find((r) => r.userId === u.id)).toMatchObject({
      status: 'failed',
      lastError: 'unlinked',
    });
    expect(rows.find((r) => r.userId === other.id)!.status).toBe('pending');
    expect((await claimOutbox(deps, {})).map((i) => i.chatId)).toEqual(['7202']);
  });

  it('unlinking another provider keeps Telegram rows', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7301');
    await db.insert(authIdentities).values({ userId: u.id, provider: 'google', subject: 'g-2' });
    await reminder(u.id);
    await unlinkIdentity(deps, u.id, 'google');
    expect((await outbox())[0]!.status).toBe('pending');
  });

  it('deleting the account fails its pending rows; sent rows stay sent', async () => {
    const u = await createUser(db);
    await linkTelegram(u.id, '7401');
    await reminder(u.id, 5);
    await reminder(u.id, 6);
    const [first] = await outbox();
    await markOutboxSent(deps, first!.id);
    await deleteAccount(deps, u.id);
    const rows = await outbox();
    expect(rows.map((r) => [r.status, r.lastError])).toEqual([
      ['sent', null],
      ['failed', 'unlinked'],
    ]);
  });
});

describe('claim query plan', () => {
  it('uses an index on status (no full scan); ordered by id without filesort', async () => {
    await seed(3);
    const now = new Date();
    const [rows] = (await db.execute(
      sql`EXPLAIN SELECT * FROM telegram_outbox WHERE status = 'pending' AND next_try_at <= ${now}
        AND (locked_until IS NULL OR locked_until < ${now}) AND attempts < 5
        AND created_at >= ${now} ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`,
    )) as unknown as [{ key: string | null; Extra: string | null }[]];
    expect(rows[0]!.key).not.toBeNull();
    expect(rows[0]!.Extra ?? '').not.toContain('filesort');
  });
});

describe('purge', () => {
  it('deletes sent/failed rows older than 30 days, keeps the rest', async () => {
    const [oldSent, oldFailed, oldPending, freshSent] = await seed(4);
    const old = new Date(Date.now() - 31 * 86_400_000);
    const fresh = new Date(Date.now() - 29 * 86_400_000);
    const set = (id: number, status: 'sent' | 'failed' | 'pending', updatedAt: Date) =>
      db.update(telegramOutbox).set({ status, updatedAt }).where(eq(telegramOutbox.id, id));
    await set(oldSent!, 'sent', old);
    await set(oldFailed!, 'failed', old);
    await set(oldPending!, 'pending', old);
    await set(freshSent!, 'sent', fresh);
    expect(await purgeTelegramOutbox(deps)).toBe(2);
    expect((await outbox()).map((r) => r.id)).toEqual([oldPending, freshSent]);
  });

  it('is a daily step', async () => {
    const [id] = await seed(1);
    await db
      .update(telegramOutbox)
      .set({ status: 'sent', updatedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(telegramOutbox.id, id!));
    await runDaily(deps);
    expect(await outbox()).toHaveLength(0);
  });
});
