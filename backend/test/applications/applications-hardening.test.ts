import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  gameApplications,
  notifications,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { runApplicationsHousekeeping } from '../../src/applications/applications.housekeeping.js';
import { dispatchEvents } from '../../src/notifications/dispatcher.js';
import type { RealtimeHub } from '../../src/realtime/socket.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

const emitted: { userId: number; event: string }[] = [];
deps.realtime = {
  toUser: (userId, event) => void emitted.push({ userId, event }),
  toRoom: () => {},
  disconnectUser: () => {},
  disconnectSession: () => {},
  joinRoom: () => {},
  leaveRoom: () => {},
  closeRoom: () => {},
  revalidateSockets: async () => 0,
  close: async () => {},
} satisfies RealtimeHub;

beforeEach(async () => {
  emitted.length = 0;
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
const APPLY = { warningsAccepted: true, answers: [] as string[] };

async function setup() {
  const gm = await userWithAge(30, 'Gm');
  const gameId = await createGame(gm.cookie, {}, true);
  const p = await userWithAge(25, 'Player');
  return { gm, gameId, p };
}

const apply = (gameId: number, cookie: string) =>
  call('post', `/api/games/${gameId}/applications`, cookie, APPLY);

async function applyOk(gameId: number, cookie: string): Promise<number> {
  const r = await apply(gameId, cookie);
  if (r.status !== 201) throw new Error(`apply ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as number;
}

/** Зсуває час рішення заявки в минуле на `ms`. */
async function decidedAgo(id: number, ms: number): Promise<Date> {
  const at = new Date(Date.now() - ms);
  await db.update(gameApplications).set({ decidedAt: at }).where(eq(gameApplications.id, id));
  return at;
}

async function createdAgo(id: number, ms: number): Promise<void> {
  await db
    .update(gameApplications)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(gameApplications.id, id));
}

const notesOf = (userId: number) =>
  db.select().from(notifications).where(eq(notifications.userId, userId));

const typesOf = async (userId: number) => (await notesOf(userId)).map((n) => n.type).sort();

describe('application cooldown', () => {
  it('10 min after own withdrawal: 9 min → 409 with retryAt, 11 min → 201', async () => {
    const { gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    expect((await call('delete', `/api/applications/${id}`, p.cookie)).status).toBe(200);
    const at = await decidedAgo(id, 9 * MIN);
    const r = await apply(gameId, p.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('APPLICATION_COOLDOWN');
    const retryAt = new Date(r.body.error.details.retryAt as string).getTime();
    // `decided_at` — DATETIME без часток секунди.
    expect(Math.abs(retryAt - (at.getTime() + 10 * MIN))).toBeLessThan(1500);
    await decidedAgo(id, 11 * MIN);
    expect((await apply(gameId, p.cookie)).status).toBe(201);
  });

  it('1 h after rejection by the GM', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    expect((await call('post', `/api/applications/${id}/reject`, gm.cookie)).status).toBe(200);
    await decidedAgo(id, 50 * MIN);
    const r = await apply(gameId, p.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('APPLICATION_COOLDOWN');
    expect(typeof r.body.error.details.retryAt).toBe('string');
    await decidedAgo(id, 70 * MIN);
    expect((await apply(gameId, p.cookie)).status).toBe(201);
  });

  it('does not apply across games', async () => {
    const { gm, gameId, p } = await setup();
    const other = await createGame(gm.cookie, {}, true);
    const id = await applyOk(gameId, p.cookie);
    await call('post', `/api/applications/${id}/reject`, gm.cookie);
    expect((await apply(other, p.cookie)).status).toBe(201);
  });

  it('no cooldown after an expired application', async () => {
    const { gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    await runApplicationsHousekeeping(deps, new Date(Date.now() + 14 * DAY + MIN));
    const [row] = await db.select().from(gameApplications).where(eq(gameApplications.id, id));
    expect(row!.status).toBe('expired');
    expect((await apply(gameId, p.cookie)).status).toBe(201);
  });
});

describe('quick withdrawal (< 2 min)', () => {
  it('GM gets no «withdrawn», the unread «new application» and its pending outbox row vanish', async () => {
    const { gm, gameId, p } = await setup();
    await db
      .insert(authIdentities)
      .values({ userId: gm.id, provider: 'telegram', subject: '7001' });
    const id = await applyOk(gameId, p.cookie);
    await dispatchEvents(deps);
    expect(await typesOf(gm.id)).toEqual(['application.created']);
    expect(await db.select().from(telegramOutbox)).toHaveLength(1);
    emitted.length = 0;
    expect((await call('delete', `/api/applications/${id}`, p.cookie)).status).toBe(200);
    await dispatchEvents(deps);
    expect(await typesOf(gm.id)).toEqual([]);
    expect(await db.select().from(telegramOutbox)).toHaveLength(0);
    // Лічильник у вкладках майстра перечитується.
    expect(emitted).toContainEqual({ userId: gm.id, event: 'notification.new' });
  });

  it('withdrawn before dispatch: GM gets nothing at all', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    expect((await call('delete', `/api/applications/${id}`, p.cookie)).status).toBe(200);
    await dispatchEvents(deps);
    expect(await typesOf(gm.id)).toEqual([]);
  });

  it('an already read «new application» stays; still no «withdrawn»', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    await dispatchEvents(deps);
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.userId, gm.id));
    await call('delete', `/api/applications/${id}`, p.cookie);
    await dispatchEvents(deps);
    expect(await typesOf(gm.id)).toEqual(['application.created']);
  });

  it('withdrawal after 3 min — as before: both notifications', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    await dispatchEvents(deps);
    await createdAgo(id, 3 * MIN);
    await call('delete', `/api/applications/${id}`, p.cookie);
    await dispatchEvents(deps);
    expect(await typesOf(gm.id)).toEqual(['application.created', 'application.withdrawn']);
  });
});

describe('applications.housekeeping', () => {
  it('3 days pending → exactly one reminder to the GM (two runs)', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    await dispatchEvents(deps);
    expect(await runApplicationsHousekeeping(deps, new Date(Date.now() + 2 * DAY))).toEqual({
      reminded: 0,
      expired: 0,
    });
    const now = new Date(Date.now() + 3 * DAY + MIN);
    expect(await runApplicationsHousekeeping(deps, now)).toEqual({ reminded: 1, expired: 0 });
    expect(await runApplicationsHousekeeping(deps, now)).toEqual({ reminded: 0, expired: 0 });
    const reminders = (await notesOf(gm.id)).filter(
      (n) => n.type === 'application.pending_reminder',
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      category: 'applications',
      entityType: 'application',
      entityId: id,
    });
    expect(reminders[0]!.payload).toMatchObject({ gameId, applicationId: id });
    const [row] = await db.select().from(gameApplications).where(eq(gameApplications.id, id));
    expect(row!.status).toBe('pending');
    expect(row!.remindedAt).not.toBeNull();
    expect(emitted).toContainEqual({ userId: gm.id, event: 'notification.new' });
  });

  it('14 days pending → expired, player notified, GM approve → 409', async () => {
    const { gm, gameId, p } = await setup();
    const id = await applyOk(gameId, p.cookie);
    expect(await runApplicationsHousekeeping(deps, new Date(Date.now() + 14 * DAY + MIN))).toEqual({
      reminded: 0,
      expired: 1,
    });
    const [row] = await db.select().from(gameApplications).where(eq(gameApplications.id, id));
    expect(row!.status).toBe('expired');
    expect(row!.decidedAt).not.toBeNull();
    const player = await notesOf(p.id);
    expect(player.map((n) => n.type)).toEqual(['application.expired']);
    expect(player[0]!.payload).toMatchObject({ gameId, applicationId: id });
    for (const action of ['approve', 'reject']) {
      const r = await call('post', `/api/applications/${id}/${action}`, gm.cookie);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('APPLICATION_CLOSED');
    }
    const mine = await call('get', '/api/me/applications', p.cookie);
    expect(mine.body[0].status).toBe('expired');
  });

  it('concurrent runs do not duplicate reminders or expiry notices', async () => {
    const { gm, gameId, p } = await setup();
    const p2 = await userWithAge(25, 'P2');
    const a = await applyOk(gameId, p.cookie);
    await applyOk(gameId, p2.cookie);
    // Перша — 15 днів (прострочиться), друга — 4 дні (нагадування).
    await createdAgo(a, 11 * DAY);
    const now = new Date(Date.now() + 4 * DAY);
    const runs = await Promise.all([
      runApplicationsHousekeeping(deps, now),
      runApplicationsHousekeeping(deps, now),
      runApplicationsHousekeeping(deps, now),
    ]);
    expect(runs.reduce((s, r) => s + r.reminded, 0)).toBe(1);
    expect(runs.reduce((s, r) => s + r.expired, 0)).toBe(1);
    expect(await typesOf(gm.id)).toEqual(['application.pending_reminder']);
    expect(await typesOf(p.id)).toEqual(['application.expired']);
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, p2.id)))) as [{ n: number }];
    expect(Number(n)).toBe(0);
  });
});
