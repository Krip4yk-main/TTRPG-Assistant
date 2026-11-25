import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { toZoned, zonedToUtc } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { events, gameSessions, jobs, notifications, users } from '../../src/db/schema/index.js';
import { logEvent } from '../../src/events/events.service.js';
import { registerJobs } from '../../src/jobs/index.js';
import { ensureRecurring, resetRegistry } from '../../src/jobs/registry.js';
import { runDueJobs } from '../../src/jobs/worker.js';
import { DISPATCH_JOB, dispatchEvents } from '../../src/notifications/dispatcher.js';
import type { RealtimeHub } from '../../src/realtime/socket.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

const emitted: { userId: number; event: string; payload: unknown }[] = [];
deps.realtime = {
  toUser: (userId, event, payload) => void emitted.push({ userId, event, payload }),
  toRoom: () => {},
  disconnectUser: () => {},
  disconnectSession: () => {},
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

const DAY = 86_400_000;
const TZ = 'Europe/Kyiv';
const APPLY = { warningsAccepted: true, answers: [] as string[] };
const LEAVE = { noteForGm: 'Не встигаю за розкладом' };

function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekday: z.weekday };
}

type User = Awaited<ReturnType<typeof userWithAge>>;

async function apply(gameId: number, p: User): Promise<number> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.id as number;
}

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const id = await apply(gameId, p);
  const ok = await call('post', `/api/applications/${id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status} ${JSON.stringify(ok.body)}`);
}

async function ok(res: Promise<{ status: number; body: unknown }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

/**
 * Щотижнева кампанія (перша сесія через 2 доби): майстер, два активні учасники, колишній
 * учасник і сторонній. Усі події налаштування вже оброблено.
 */
async function party(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30, 'Майстер');
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday], ...patch },
    true,
  );
  const p1 = await userWithAge(25, 'Перший');
  const p2 = await userWithAge(25, 'Другий');
  const former = await userWithAge(25, 'Колишній');
  const stranger = await userWithAge(25, 'Сторонній');
  for (const p of [p1, p2, former]) await join(gm, gameId, p);
  await ok(call('post', `/api/games/${gameId}/leave`, former.cookie, LEAVE), 204);
  await dispatchEvents(deps);
  emitted.length = 0;
  return { gm, gameId, p1, p2, former, stranger, first };
}

/** Обробляє черговий outbox і повертає отримувачів сповіщень типу `type` (за зростанням). */
async function notifiedOf(type: string): Promise<number[]> {
  await dispatchEvents(deps);
  const rows = await db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.type, type));
  return rows.map((r) => r.userId).sort((a, b) => a - b);
}

const ids = (...us: User[]) => us.map((u) => u.id).sort((a, b) => a - b);

async function one(type: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.type, type));
  return row!;
}

const sessionsOf = (gameId: number) =>
  db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));

describe('recipients: applications', () => {
  it('created/withdrawn → GM; approved/rejected → applicant; never the actor', async () => {
    const gm = await userWithAge(30, 'Майстер');
    const gameId = await createGame(gm.cookie, {}, true);
    const a = await userWithAge(25, 'Аня');
    const b = await userWithAge(25, 'Богдан');
    const c = await userWithAge(25, 'Віра');
    const appA = await apply(gameId, a);
    const appB = await apply(gameId, b);
    const appC = await apply(gameId, c);
    expect(await notifiedOf('application.created')).toEqual(ids(gm, gm, gm));
    await ok(call('post', `/api/applications/${appA}/approve`, gm.cookie));
    await ok(call('post', `/api/applications/${appB}/reject`, gm.cookie));
    await ok(call('delete', `/api/applications/${appC}`, c.cookie));
    expect(await notifiedOf('application.approved')).toEqual(ids(a));
    expect(await notifiedOf('application.rejected')).toEqual(ids(b));
    expect(await notifiedOf('application.withdrawn')).toEqual(ids(gm));

    const created = await one('application.created');
    expect(created).toMatchObject({ category: 'applications', entityType: 'application' });
    expect(created.payload).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      applicationId: appA,
      actor: { publicId: a.publicId, nickname: 'Аня' },
    });
    const approved = await one('application.approved');
    expect(approved.payload).toMatchObject({
      gameId,
      applicationId: appA,
      actor: { publicId: gm.publicId, nickname: 'Майстер' },
    });
  });

  it('cancelled_age / cancelled_game → applicant only, with no actor', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    const minor = await userWithAge(17, 'Юний');
    const adult = await userWithAge(25, 'Дорослий');
    await apply(gameId, minor);
    await apply(gameId, adult);
    await ok(call('patch', `/api/games/${gameId}`, gm.cookie, { ageRating: '18+' }));
    expect(await notifiedOf('application.cancelled_age')).toEqual(ids(minor));
    expect((await one('application.cancelled_age')).payload).toMatchObject({ actor: null });
    await ok(call('post', `/api/games/${gameId}/cancel`, gm.cookie));
    expect(await notifiedOf('application.cancelled_game')).toEqual(ids(adult));
  });
});

describe('recipients: members', () => {
  it('left → GM; kicked/banned → the member only', async () => {
    const { gm, gameId, p1, p2, stranger } = await party();
    expect(
      (await db.select().from(notifications).where(eq(notifications.type, 'member.left'))).map(
        (n) => n.userId,
      ),
    ).toEqual([gm.id]);
    await ok(call('post', `/api/games/${gameId}/members/${p1.publicId}/kick`, gm.cookie), 204);
    await ok(call('post', `/api/games/${gameId}/members/${p2.publicId}/ban`, gm.cookie), 204);
    expect(await notifiedOf('member.kicked')).toEqual(ids(p1));
    expect(await notifiedOf('member.banned')).toEqual(ids(p2));
    const kicked = await one('member.kicked');
    expect(kicked).toMatchObject({ category: 'members', entityType: 'game', entityId: gameId });
    expect(kicked.payload).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      actor: { publicId: gm.publicId, nickname: 'Майстер' },
    });
    // Бан не-учасника (сторонній) — теж йому.
    await ok(call('post', `/api/games/${gameId}/members/${stranger.publicId}/ban`, gm.cookie), 204);
    expect(await notifiedOf('member.banned')).toEqual(ids(p2, stranger));
  });
});

describe('recipients: sessions', () => {
  it('rescheduled/cancelled → active members, not the GM-actor, former members or strangers', async () => {
    const { gm, gameId, p1, p2 } = await party();
    const [s1, s2] = await sessionsOf(gameId);
    const to = kyivAt(4, 18).startsAt;
    await ok(call('post', `/api/sessions/${s1!.id}/reschedule`, gm.cookie, { startsAt: to }));
    await ok(call('post', `/api/sessions/${s2!.id}/cancel`, gm.cookie, { reason: 'Захворів' }));
    expect(await notifiedOf('session.rescheduled')).toEqual(ids(p1, p2));
    expect(await notifiedOf('session.cancelled')).toEqual(ids(p1, p2));
    const r = await one('session.rescheduled');
    expect(r).toMatchObject({ category: 'sessions', entityType: 'session', entityId: s1!.id });
    expect(r.payload).toMatchObject({
      gameId,
      sessionId: s1!.id,
      from: s1!.startsAt.toISOString(),
      startsAt: to,
    });
    expect((await one('session.cancelled')).payload).toMatchObject({
      sessionId: s2!.id,
      startsAt: s2!.startsAt.toISOString(),
      reason: 'Захворів',
    });
  });

  it('deleted or pending accounts are never notified', async () => {
    const { gm, gameId, p1, p2 } = await party();
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, p2.id));
    const [s1] = await sessionsOf(gameId);
    await ok(call('post', `/api/sessions/${s1!.id}/cancel`, gm.cookie, { reason: 'Ні' }));
    expect(await notifiedOf('session.cancelled')).toEqual(ids(p1));
  });
});

describe('recipients: games', () => {
  it('started / rule_changed / finished → active members; auto-cancelled sessions are silent', async () => {
    const { gm, gameId, p1, p2 } = await party();
    await ok(call('post', `/api/games/${gameId}/start`, gm.cookie));
    expect(await notifiedOf('game.started')).toEqual(ids(p1, p2));
    const next = kyivAt(3);
    await ok(
      call('put', `/api/games/${gameId}/schedule`, gm.cookie, {
        startsAt: next.startsAt,
        recurrence: 'weekly',
        weekdays: [next.weekday],
      }),
    );
    expect(await notifiedOf('game.rule_changed')).toEqual(ids(p1, p2));
    await ok(call('post', `/api/games/${gameId}/finish`, gm.cookie));
    expect(await notifiedOf('game.finished')).toEqual(ids(p1, p2));
    // Події session.cancelled (rule_changed / game_finished) є, сповіщень — ні.
    expect(
      (await db.select().from(events).where(eq(events.type, 'session.cancelled'))).length,
    ).toBeGreaterThan(0);
    expect(await notifiedOf('session.cancelled')).toEqual([]);
    expect((await one('game.finished')).payload).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      actor: { publicId: gm.publicId, nickname: 'Майстер' },
    });
  });

  it('converted_to_campaign → members', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(
      gm.cookie,
      { kind: 'oneshot', recurrence: 'none', weekdays: [], startsAt: kyivAt(3).startsAt },
      true,
    );
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const next = kyivAt(5);
    await ok(
      call('post', `/api/games/${gameId}/convert-to-campaign`, gm.cookie, {
        startsAt: next.startsAt,
        recurrence: 'weekly',
        weekdays: [next.weekday],
      }),
    );
    expect(await notifiedOf('game.converted_to_campaign')).toEqual(ids(p));
  });

  it('cancelled by the GM → members; by account deletion → members with anonymous actor', async () => {
    const { gm, gameId, p1, p2 } = await party();
    await ok(call('post', `/api/games/${gameId}/cancel`, gm.cookie));
    expect(await notifiedOf('game.cancelled')).toEqual(ids(p1, p2));

    const gm2 = await userWithAge(30);
    const g2 = await createGame(gm2.cookie, {}, true);
    const m = await userWithAge(25);
    await join(gm2, g2, m);
    await ok(call('delete', '/api/me', gm2.cookie), 204);
    await dispatchEvents(deps);
    const rows = await db
      .select()
      .from(notifications)
      .where(sql`${notifications.type} = 'game.cancelled' AND ${notifications.entityId} = ${g2}`);
    expect(rows.map((r) => r.userId)).toEqual([m.id]);
    expect(rows[0]!.payload).toMatchObject({ reason: 'account_deleted', actor: null });
  });
});

describe('dispatcher', () => {
  it('events without recipients are marked dispatched and create nothing', async () => {
    const u = await userWithAge(30);
    await ok(call('patch', '/api/me/timezone', u.cookie, { timezone: 'Europe/Warsaw' }));
    await createGame(u.cookie, {}, true); // game.created + game.published
    expect(await dispatchEvents(deps)).toBeGreaterThan(0);
    expect(await db.select().from(notifications)).toEqual([]);
    expect(await db.select().from(events).where(isNull(events.dispatchedAt))).toEqual([]);
    expect(await dispatchEvents(deps)).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('reprocessing the same events creates no duplicates and no pings', async () => {
    const { gm, gameId } = await party();
    const [s1] = await sessionsOf(gameId);
    await ok(call('post', `/api/sessions/${s1!.id}/cancel`, gm.cookie, { reason: 'Ні' }));
    await dispatchEvents(deps);
    const before = await db.select().from(notifications);
    emitted.length = 0;
    await db.update(events).set({ dispatchedAt: null });
    await dispatchEvents(deps);
    expect(await db.select().from(notifications)).toEqual(before);
    expect(emitted).toEqual([]);
  });

  it('two concurrent dispatchers do not duplicate and process every event once', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    const players = await Promise.all(Array.from({ length: 6 }, () => userWithAge(25)));
    for (const p of players) await apply(gameId, p);
    const results = await Promise.all([
      dispatchEvents(deps, { limit: 3 }),
      dispatchEvents(deps, { limit: 3 }),
      dispatchEvents(deps, { limit: 3 }),
    ]);
    while ((await dispatchEvents(deps, { limit: 3 })) > 0);
    expect(results.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      (await db.select().from(events)).length,
    );
    const rows = await db.select().from(notifications);
    expect(rows.filter((r) => r.type === 'application.created')).toHaveLength(6);
    expect(new Set(rows.map((r) => `${r.eventId}:${r.userId}`)).size).toBe(rows.length);
    expect(emitted.filter((e) => e.userId === gm.id)).toHaveLength(6);
  });

  it('skips an uncommitted event and picks it up after commit (no id cursor)', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    const p = await userWithAge(25);
    await dispatchEvents(deps);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const slow = db.transaction(async (tx) => {
      await tx.insert(events).values({
        type: 'application.created',
        userId: p.id,
        entityType: 'application',
        entityId: 1,
        payload: { gameId },
      });
      inserted();
      await gate;
    });
    await insertedP;
    // Пізніша, але вже закомічена подія обробляється, рання незакомічена — пропускається.
    await logEvent(db, {
      type: 'application.created',
      userId: p.id,
      entityType: 'application',
      entityId: 2,
      payload: { gameId },
    });
    expect(await dispatchEvents(deps)).toBe(1);
    release();
    await slow;
    expect(await dispatchEvents(deps)).toBe(1);
    expect(await notifiedOf('application.created')).toEqual([gm.id, gm.id]);
  });

  it('pings notification.new {id} only after commit', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    const p = await userWithAge(25);
    await dispatchEvents(deps);
    await apply(gameId, p);
    const seen: unknown[] = [];
    const prev = deps.realtime!;
    deps.realtime = {
      ...prev,
      toUser: (userId, event, payload) => {
        // Окреме з'єднання пулу бачить лише закомічене.
        seen.push(
          db
            .select()
            .from(notifications)
            .where(eq(notifications.id, (payload as { id: number }).id))
            .then((r) => ({ userId, event, payload, committed: r.length === 1 })),
        );
      },
    };
    try {
      await dispatchEvents(deps);
    } finally {
      deps.realtime = prev;
    }
    const [n] = await db.select().from(notifications);
    expect(await Promise.all(seen)).toEqual([
      { userId: gm.id, event: 'notification.new', payload: { id: n!.id }, committed: true },
    ]);
  });

  it('tolerates a missing realtime hub', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    await apply(gameId, await userWithAge(25));
    const prev = deps.realtime;
    deps.realtime = undefined;
    try {
      await dispatchEvents(deps);
    } finally {
      deps.realtime = prev;
    }
    expect(await notifiedOf('application.created')).toEqual([gm.id]);
  });

  it('migration 0012 backfill marks pre-existing events dispatched (history is not notified)', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    await apply(gameId, await userWithAge(25));
    const migration = readFileSync('src/db/migrations/0012_plan4_notifications.sql', 'utf8');
    const backfill = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.includes('UPDATE `events`'))!;
    await db.execute(sql.raw(backfill));
    expect(await db.select().from(events).where(isNull(events.dispatchedAt))).toEqual([]);
    expect(await dispatchEvents(deps)).toBe(0);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('runs as the recurring notifications.dispatch job', async () => {
    resetRegistry();
    try {
      registerJobs();
      await ensureRecurring(deps);
      const [job] = await db.select().from(jobs).where(eq(jobs.type, DISPATCH_JOB));
      expect(job).toBeDefined();
      const gm = await userWithAge(30);
      const gameId = await createGame(gm.cookie, {}, true);
      await apply(gameId, await userWithAge(25));
      await runDueJobs(deps, new Date(job!.runAt.getTime() + 1));
      expect((await db.select().from(notifications)).map((n) => n.userId)).toEqual([gm.id]);
    } finally {
      resetRegistry();
    }
  });
});
