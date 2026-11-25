import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  games,
  gameSessions,
  jobs,
  notificationPrefs,
  notifications,
  reminderLog,
  users,
} from '../../src/db/schema/index.js';
import { registerJobs } from '../../src/jobs/index.js';
import { enqueue } from '../../src/jobs/queue.js';
import { ensureRecurring, resetRegistry } from '../../src/jobs/registry.js';
import { runDueJobs } from '../../src/jobs/worker.js';
import { REMINDERS_JOB, sendReminders } from '../../src/notifications/reminders.js';
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
const APPLY = { warningsAccepted: true, answers: [] as string[] };

type User = Awaited<ReturnType<typeof userWithAge>>;

async function ok(res: Promise<{ status: number; body: unknown }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await ok(call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY), 201);
  await ok(call('post', `/api/applications/${(a.body as { id: number }).id}/approve`, gm.cookie));
}

/** Початок сесії — через 3 доби, рівно на хвилині (datetime без дробу). */
const T = new Date(Math.floor((Date.now() + 3 * 24 * HOUR) / MIN) * MIN);

/**
 * Опублікована гра: майстер, два активні учасники, колишній учасник, сторонній; сесії
 * правила прибрано, лишається одна ручна сесія о `T`.
 */
async function party() {
  const gm = await userWithAge(30, 'Майстер');
  const gameId = await createGame(gm.cookie, {}, true);
  const p1 = await userWithAge(25, 'Перший');
  const p2 = await userWithAge(25, 'Другий');
  const former = await userWithAge(25, 'Колишній');
  const stranger = await userWithAge(25, 'Сторонній');
  for (const p of [p1, p2, former]) await join(gm, gameId, p);
  await ok(
    call('post', `/api/games/${gameId}/leave`, former.cookie, { noteForGm: 'Не встигаю' }),
    204,
  );
  await db.delete(gameSessions).where(eq(gameSessions.gameId, gameId));
  const [s] = await db
    .insert(gameSessions)
    .values({ gameId, startsAt: T, durationMinutes: 240, origin: 'manual' })
    .$returningId();
  return { gm, gameId, p1, p2, former, stranger, sessionId: s!.id };
}

const at = (moment: number) => new Date(moment);
/** Запуск, запланований рівно на момент нагадування `start − offset`. */
const runFor = (start: Date, offsetMin: number) => at(start.getTime() - offsetMin * MIN);

async function reminders() {
  return db.select().from(notifications).where(eq(notifications.type, 'session.reminder'));
}
const recipients = async (offsetMin?: number) =>
  (await reminders())
    .filter((n) => offsetMin === undefined || n.payload.offsetMin === offsetMin)
    .map((n) => n.userId)
    .sort((a, b) => a - b);
const ids = (...us: { id: number }[]) => us.map((u) => u.id).sort((a, b) => a - b);

describe('session reminders', () => {
  it('reminds GM and active members only, with params and a ping after commit', async () => {
    const { gm, gameId, p1, p2, sessionId } = await party();
    const created = await sendReminders(deps, runFor(T, 60));
    expect(created).toHaveLength(3);
    expect(await recipients()).toEqual(ids(gm, p1, p2));
    const [n] = await reminders();
    expect(n!.category).toBe('reminders');
    expect(n!.eventId).toBeNull();
    expect(n!.entityType).toBe('session');
    expect(n!.entityId).toBe(sessionId);
    expect(n!.payload).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      sessionId,
      startsAt: T.toISOString(),
      offsetMin: 60,
    });
    expect(emitted.map((e) => e.userId).sort((a, b) => a - b)).toEqual(ids(gm, p1, p2));
    expect(emitted.every((e) => e.event === 'notification.new')).toBe(true);
    expect(await db.select().from(reminderLog)).toHaveLength(3);
  });

  it('a moment outside the window sends nothing (default offsets 1440 and 60 only)', async () => {
    await party();
    await sendReminders(deps, runFor(T, 180)); // 3 год — не за замовчуванням
    await sendReminders(deps, at(T.getTime() - 2 * HOUR)); // між моментами
    expect(await reminders()).toHaveLength(0);
  });

  it('rerun, overlapping windows and concurrent runs do not duplicate', async () => {
    await party();
    const runAt = runFor(T, 60);
    await sendReminders(deps, runAt);
    await sendReminders(deps, runAt);
    await sendReminders(deps, at(runAt.getTime() + 5 * MIN)); // наступний слот, вікно перетинається
    expect(await reminders()).toHaveLength(3);

    await db.delete(notifications);
    await db.delete(reminderLog);
    const results = await Promise.all([
      sendReminders(deps, runAt),
      sendReminders(deps, runAt),
      sendReminders(deps, at(runAt.getTime() - 5 * MIN)),
    ]);
    expect(results.flat()).toHaveLength(3);
    expect(await reminders()).toHaveLength(3);
    expect(await db.select().from(reminderLog)).toHaveLength(3);
  });

  it('cancelled session: no reminders', async () => {
    const { gm, sessionId } = await party();
    await ok(call('post', `/api/sessions/${sessionId}/cancel`, gm.cookie, { reason: 'Хворію' }));
    await sendReminders(deps, runFor(T, 1440));
    await sendReminders(deps, runFor(T, 60));
    expect(await reminders()).toHaveLength(0);
  });

  it('rescheduled session: reminders at the new time, the old moments stay silent', async () => {
    const { gm, p1, p2, sessionId } = await party();
    await sendReminders(deps, runFor(T, 1440)); // 24 год до старого часу
    expect(await recipients(1440)).toEqual(ids(gm, p1, p2));

    const T2 = new Date(T.getTime() + 5 * HOUR);
    await ok(
      call('post', `/api/sessions/${sessionId}/reschedule`, gm.cookie, {
        startsAt: T2.toISOString(),
      }),
    );
    await sendReminders(deps, runFor(T, 60)); // старий момент «за годину»
    expect(await recipients(60)).toEqual([]);

    await sendReminders(deps, runFor(T2, 1440)); // 24 год до нового часу — свіже нагадування
    await sendReminders(deps, runFor(T2, 60));
    expect(await recipients(1440)).toEqual(ids(gm, gm, p1, p1, p2, p2));
    expect(await recipients(60)).toEqual(ids(gm, p1, p2));
    const fresh = (await reminders()).filter((n) => n.payload.startsAt === T2.toISOString());
    expect(fresh).toHaveLength(6);
  });

  it('respects reminder prefs: [] gets nothing, custom offsets only those', async () => {
    const { gm, p1, p2 } = await party();
    await db.insert(notificationPrefs).values([
      { userId: p1.id, telegram: {}, reminderOffsets: [] },
      { userId: p2.id, telegram: {}, reminderOffsets: [15, 180] },
    ] as (typeof notificationPrefs.$inferInsert)[]);
    for (const o of [2880, 1440, 180, 60, 15]) await sendReminders(deps, runFor(T, o));
    expect(await recipients(1440)).toEqual(ids(gm));
    expect(await recipients(60)).toEqual(ids(gm));
    expect(await recipients(180)).toEqual(ids(p2));
    expect(await recipients(15)).toEqual(ids(p2));
    expect(await recipients(2880)).toEqual([]);
    expect(await recipients()).not.toContain(p1.id);
  });

  it('former members, strangers, deleted and banned accounts get nothing', async () => {
    const { gm, p1, p2, former, stranger } = await party();
    await db.update(users).set({ status: 'deleted' }).where(eq(users.id, p1.id));
    await db.update(users).set({ isBanned: true }).where(eq(users.id, p2.id));
    await sendReminders(deps, runFor(T, 60));
    const got = await recipients();
    expect(got).toEqual(ids(gm));
    expect(got).not.toContain(former.id);
    expect(got).not.toContain(stranger.id);
  });

  it.each(['finished', 'cancelled', 'draft'] as const)('%s game: nothing', async (status) => {
    const { gameId } = await party();
    await db.update(games).set({ status }).where(eq(games.id, gameId));
    await sendReminders(deps, runFor(T, 60));
    expect(await reminders()).toHaveLength(0);
  });

  it('started game still reminds', async () => {
    const { gm, gameId } = await party();
    await ok(call('post', `/api/games/${gameId}/start`, gm.cookie));
    await sendReminders(deps, runFor(T, 60));
    expect(await reminders()).toHaveLength(3);
  });

  it('session already started: nothing', async () => {
    await party();
    // Задача «за 15 хв» запізнилась так, що сесія вже почалась (і запас ще не вичерпано).
    await sendReminders(deps, runFor(T, 15), at(T.getTime() + MIN));
    expect(await reminders()).toHaveLength(0);
  });

  it('a late run within the 15 min grace still sends, beyond it does not', async () => {
    await party();
    const moment = runFor(T, 60).getTime();
    await sendReminders(deps, at(moment + 16 * MIN));
    expect(await reminders()).toHaveLength(0);
    await sendReminders(deps, at(moment + 14 * MIN));
    expect(await reminders()).toHaveLength(3);
  });

  it('runs as the recurring job using job.runAt as the window', async () => {
    resetRegistry();
    try {
      registerJobs();
      await ensureRecurring(deps);
      const types = (await db.select({ type: jobs.type }).from(jobs)).map((j) => j.type);
      expect(types).toContain(REMINDERS_JOB);
      expect(types).toContain('maintenance.daily');
      await db.delete(jobs);

      await party();
      const runAt = runFor(T, 60);
      await enqueue(deps, { type: REMINDERS_JOB, runAt });
      // Воркер «запізнився» на 10 хв, але вікно рахується від запланованого слоту.
      await runDueJobs(deps, at(runAt.getTime() + 10 * MIN));
      expect(await reminders()).toHaveLength(3);
      const [done] = await db.select().from(jobs).where(eq(jobs.runAt, runAt));
      expect(done!.status).toBe('done');
    } finally {
      resetRegistry();
    }
  });
});
