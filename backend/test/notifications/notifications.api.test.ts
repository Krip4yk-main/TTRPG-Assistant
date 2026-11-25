import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { notificationPrefs, notifications } from '../../src/db/schema/index.js';
import { createNotification } from '../../src/notifications/notifications.service.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, login } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

/** `n` сповіщень користувачу (session.reminder, без події); повертає id за зростанням. */
async function seed(userId: number, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = await db.transaction((tx) =>
      createNotification(deps, tx, {
        userId,
        type: 'session.reminder',
        category: 'reminders',
        params: { gameId: 7, gameTitle: 'Гра', sessionId: 100 + i, offsetMin: 60 },
        entityType: 'session',
        entityId: 100 + i,
      }),
    );
    out.push(row.id);
  }
  return out;
}

describe('GET /api/me/notifications', () => {
  it('own only, newest first, cursor pagination, limit ≤ 50', async () => {
    const u = await userWithAge(25);
    const other = await userWithAge(25);
    const mine = await seed(u.id, 5);
    await seed(other.id, 2);
    const p1 = await call('get', '/api/me/notifications?limit=2', u.cookie);
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((n: { id: number }) => n.id)).toEqual([mine[4], mine[3]]);
    expect(p1.body.nextCursor).toBe(mine[3]);
    expect(p1.body.items[0]).toEqual({
      id: mine[4],
      type: 'session.reminder',
      category: 'reminders',
      params: { gameId: 7, gameTitle: 'Гра', sessionId: 104, offsetMin: 60 },
      link: '/games/7',
      createdAt: expect.any(String),
      readAt: null,
    });
    const p2 = await call('get', `/api/me/notifications?limit=2&cursor=${mine[3]}`, u.cookie);
    expect(p2.body.items.map((n: { id: number }) => n.id)).toEqual([mine[2], mine[1]]);
    const p3 = await call('get', `/api/me/notifications?limit=2&cursor=${mine[1]}`, u.cookie);
    expect(p3.body).toEqual({
      items: [expect.objectContaining({ id: mine[0] })],
      nextCursor: null,
    });
    const all = await call('get', '/api/me/notifications', u.cookie);
    expect(all.body.items).toHaveLength(5);
    expect((await call('get', '/api/me/notifications?limit=51', u.cookie)).status).toBe(400);
    expect((await call('get', '/api/me/notifications?cursor=x', u.cookie)).status).toBe(400);
    const empty = await call('get', '/api/me/notifications?cursor=', u.cookie);
    expect(empty.body.items).toHaveLength(5);
  });

  it('requires an active session', async () => {
    expect((await call('get', '/api/me/notifications')).status).toBe(401);
    const { createUser } = await import('../helpers.js');
    const pending = await createUser(db, { status: 'pending' });
    const res = await call('get', '/api/me/notifications', await login(pending.id));
    expect(res.status).toBe(403);
  });
});

describe('read state', () => {
  it('unread-count, read (own only → 404 otherwise), read-all', async () => {
    const u = await userWithAge(25);
    const other = await userWithAge(25);
    const mine = await seed(u.id, 3);
    const [theirs] = await seed(other.id, 1);
    const count = async (c: string) =>
      (await call('get', '/api/me/notifications/unread-count', c)).body.count;
    expect(await count(u.cookie)).toBe(3);

    const r = await call('post', `/api/me/notifications/${mine[0]}/read`, u.cookie);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: mine[0], readAt: expect.any(String) });
    const again = await call('post', `/api/me/notifications/${mine[0]}/read`, u.cookie);
    expect(again.body.readAt).toBe(r.body.readAt);
    expect(await count(u.cookie)).toBe(2);

    expect((await call('post', `/api/me/notifications/${theirs}/read`, u.cookie)).status).toBe(404);
    expect((await call('post', '/api/me/notifications/999999/read', u.cookie)).status).toBe(404);
    expect((await call('post', '/api/me/notifications/abc/read', u.cookie)).status).toBe(404);
    const [t] = await db.select().from(notifications).where(eq(notifications.id, theirs!));
    expect(t!.readAt).toBeNull();

    expect((await call('post', '/api/me/notifications/read-all', u.cookie)).status).toBe(204);
    expect(await count(u.cookie)).toBe(0);
    expect(await count(other.cookie)).toBe(1);
  });

  it('mutations require CSRF', async () => {
    const u = await userWithAge(25);
    const [id] = await seed(u.id, 1);
    const request = (await import('supertest')).default;
    const res = await request(app).post(`/api/me/notifications/${id}/read`).set('Cookie', u.cookie);
    expect(res.status).toBe(403);
  });
});

describe('/api/me/notification-prefs', () => {
  const telegram = {
    applications: true,
    members: false,
    sessions: true,
    reminders: false,
    games: true,
    ratings: false,
    moderation: false,
  };

  it('defaults without a row; PUT replaces; per-user', async () => {
    const u = await userWithAge(25);
    const other = await userWithAge(25);
    const d = await call('get', '/api/me/notification-prefs', u.cookie);
    expect(d.status).toBe(200);
    expect(d.body).toEqual({
      telegram: {
        applications: true,
        members: true,
        sessions: true,
        reminders: true,
        games: true,
        ratings: true,
        moderation: true,
      },
      reminderOffsets: [1440, 60],
    });
    const put = await call('put', '/api/me/notification-prefs', u.cookie, {
      telegram,
      reminderOffsets: [15, 2880, 15],
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ telegram, reminderOffsets: [2880, 15] });
    expect((await call('get', '/api/me/notification-prefs', u.cookie)).body).toEqual(put.body);
    const off = await call('put', '/api/me/notification-prefs', u.cookie, {
      telegram,
      reminderOffsets: [],
    });
    expect(off.body.reminderOffsets).toEqual([]);
    expect((await db.select().from(notificationPrefs)).length).toBe(1);
    expect(
      (await call('get', '/api/me/notification-prefs', other.cookie)).body.reminderOffsets,
    ).toEqual([1440, 60]);
  });

  it('a row saved before the ratings/moderation categories reads with them on by default', async () => {
    const u = await userWithAge(25);
    const { ratings: _r, moderation: _m, ...legacy } = telegram;
    void _r;
    void _m;
    await db
      .insert(notificationPrefs)
      .values({ userId: u.id, telegram: legacy, reminderOffsets: [60] });
    const res = await call('get', '/api/me/notification-prefs', u.cookie);
    expect(res.body).toEqual({
      telegram: { ...legacy, ratings: true, moderation: true },
      reminderOffsets: [60],
    });
  });

  it('validation: allowed offsets only, ≤ 5, strict shape', async () => {
    const u = await userWithAge(25);
    for (const body of [
      { telegram, reminderOffsets: [30] },
      { telegram, reminderOffsets: [15, 60, 180, 1440, 2880, 60] },
      { telegram, reminderOffsets: ['60'] },
      { telegram: { ...telegram, extra: true }, reminderOffsets: [] },
      { telegram: { applications: true }, reminderOffsets: [] },
      { telegram, reminderOffsets: [], other: 1 },
      { telegram },
    ]) {
      const res = await call('put', '/api/me/notification-prefs', u.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
    expect(await db.select().from(notificationPrefs)).toEqual([]);
  });
});
