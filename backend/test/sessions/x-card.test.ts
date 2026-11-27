import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { toZoned, xCardWindow, zonedToUtc } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  events,
  games,
  gameSessions,
  notifications,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { raiseXCard } from '../../src/sessions/x-card.js';
import { AppError } from '../../src/http/errors.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

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

const MIN = 60_000;
const DAY = 86_400_000;
const TZ = 'Europe/Kyiv';

function kyivAt(daysAhead: number, hour = 19) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekday: z.weekday };
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

/**
 * Щотижнева кампанія з одним учасником; перша сесія зсунута так, що почалась 10 хв тому
 * (`live`), або лишається через 2 доби.
 */
async function setup(safetyTools: string[] = ['x_card'], live = true) {
  const gm = await userWithAge(30, 'Майстер');
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday], safetyTools },
    true,
  );
  const p = await userWithAge(25, 'Гравець-Таємниця');
  await join(gm, gameId, p);
  const [s] = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));
  if (live) {
    await db
      .update(gameSessions)
      .set({ startsAt: new Date(Date.now() - 10 * MIN) })
      .where(eq(gameSessions.id, s!.id));
  }
  return { gm, p, gameId, sessionId: s!.id };
}

const press = (sessionId: number, cookie: string | undefined) =>
  call('post', `/api/sessions/${sessionId}/x-card`, cookie);

const xCards = () =>
  db.select().from(notifications).where(eq(notifications.type, 'session.x_card'));

describe('POST /api/sessions/:id/x-card', () => {
  it('active member → 204; GM gets an anonymous session.x_card (site + Telegram)', async () => {
    const { gm, p, gameId, sessionId } = await setup();
    await db
      .insert(authIdentities)
      .values({ userId: gm.id, provider: 'telegram', subject: String(9000 + gm.id) });
    const eventsBefore = (await db.select().from(events)).length;
    const res = await press(sessionId, p.cookie);
    expect(res.status).toBe(204);

    const rows = await xCards();
    expect(rows).toHaveLength(1);
    const [n] = rows;
    expect(n).toMatchObject({
      userId: gm.id,
      category: 'sessions',
      eventId: null,
      entityType: 'session',
      entityId: sessionId,
    });
    const [s] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    // Лише сесія й гра — нічого про того, хто натиснув.
    expect(n!.payload).toEqual({
      gameId,
      gameTitle: 'Прокляття Страда',
      sessionId,
      startsAt: s!.startsAt.toISOString(),
      startWindowMinutes: null,
    });
    const [tg] = await db
      .select()
      .from(telegramOutbox)
      .where(eq(telegramOutbox.notificationId, n!.id));
    expect(tg).toMatchObject({ userId: gm.id, kind: 'session.x_card', buttons: null });
    expect(tg!.params).toEqual(n!.payload);

    // Анонімність: ні id, ні publicId, ні нік гравця ніде в сповіщенні, черзі чи журналі подій.
    const dump = JSON.stringify([n, tg, await db.select().from(events)]);
    expect(dump).not.toContain(p.publicId);
    expect(dump).not.toContain('Гравець-Таємниця');
    expect(n!.payload).not.toHaveProperty('actor');
    expect((await db.select().from(events)).length).toBe(eventsBefore);

    // Через API майстер бачить ту саму картину.
    const list = await call('get', '/api/me/notifications', gm.cookie);
    const dto = list.body.items.find((i: { type: string }) => i.type === 'session.x_card');
    expect(dto.params).toEqual(n!.payload);
    expect(dto.link).toBe(`/games/${gameId}?session=${sessionId}`);
  });

  it('rate limit: 1 per 5 min per user per session → 429; the next one after it is delivered too', async () => {
    const { gm, p, sessionId } = await setup();
    const other = await userWithAge(26);
    const [g] = await db
      .select({ id: games.id })
      .from(games)
      .innerJoin(gameSessions, eq(gameSessions.gameId, games.id))
      .where(eq(gameSessions.id, sessionId));
    await join(gm, g!.id, other);

    expect((await press(sessionId, p.cookie)).status).toBe(204);
    const again = await press(sessionId, p.cookie);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
    expect(again.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(again.body.error.details.retryAfterSec).toBeLessThanOrEqual(300);
    // Ліміт — на користувача: інший учасник може підняти свою картку.
    expect((await press(sessionId, other.cookie)).status).toBe(204);
    expect(await xCards()).toHaveLength(2);

    // Ключ Redis живе 5 хв; після нього (імітуємо — ключ зник) сигнал знову доходить окремим
    // сповіщенням, без дедуплікації.
    const keys = await redis.keys('rl:xcard:*');
    expect(keys).toHaveLength(2);
    expect(await redis.ttl(keys[0]!)).toBeLessThanOrEqual(300);
    await redis.del(`rl:xcard:${sessionId}:${p.id}`);
    expect((await press(sessionId, p.cookie)).status).toBe(204);
    const rows = await xCards();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it('roles: GM → 403 FORBIDDEN, stranger / former member → 403 NOT_A_MEMBER, guest → 401', async () => {
    const { gm, p, gameId, sessionId } = await setup();
    const g = await press(sessionId, gm.cookie);
    expect(g.status).toBe(403);
    expect(g.body.error.code).toBe('FORBIDDEN');
    const stranger = await userWithAge(25);
    const s = await press(sessionId, stranger.cookie);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('NOT_A_MEMBER');
    expect((await press(sessionId, undefined)).status).toBe(401);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'Не встигаю' });
    const f = await press(sessionId, p.cookie);
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe('NOT_A_MEMBER');
    expect((await press(999_999, p.cookie)).status).toBe(404);
    expect(await xCards()).toHaveLength(0);
  });

  it('GM did not enable x_card → 409 X_CARD_DISABLED (and no rate-limit key)', async () => {
    const { p, sessionId } = await setup(['open_door']);
    const res = await press(sessionId, p.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('X_CARD_DISABLED');
    expect(await redis.keys('rl:xcard:*')).toHaveLength(0);
    expect(await xCards()).toHaveLength(0);
  });

  it('outside the window, cancelled session or stopped game → 409 X_CARD_NOT_NOW', async () => {
    const future = await setup(['x_card'], false);
    const f = await press(future.sessionId, future.p.cookie);
    expect(f.status).toBe(409);
    expect(f.body.error.code).toBe('X_CARD_NOT_NOW');

    await resetDb(db);
    const live = await setup();
    await call('post', `/api/sessions/${live.sessionId}/cancel`, live.gm.cookie, {
      reason: 'Хворію',
    });
    const c = await press(live.sessionId, live.p.cookie);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('X_CARD_NOT_NOW');

    await resetDb(db);
    const stopped = await setup();
    await db.update(games).set({ status: 'finished' }).where(eq(games.id, stopped.gameId));
    const st = await press(stopped.sessionId, stopped.p.cookie);
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('X_CARD_NOT_NOW');
    expect(await xCards()).toHaveLength(0);
    expect(await redis.keys('rl:xcard:*')).toHaveLength(0);
  });

  it('window bounds: startsAt − 30 min … windowEnd + duration + 30 min, inclusive', async () => {
    const { p, sessionId } = await setup();
    const startsAt = new Date('2026-12-05T17:00:00Z');
    await db
      .update(gameSessions)
      .set({ startsAt, startWindowMinutes: 60, durationMinutes: 240 })
      .where(eq(gameSessions.id, sessionId));
    const { from, to } = xCardWindow({ startsAt, startWindowMinutes: 60, durationMinutes: 240 });
    expect(from.toISOString()).toBe('2026-12-05T16:30:00.000Z');
    // 17:00 + 60 хв вікна + 4 год + 30 хв.
    expect(to.toISOString()).toBe('2026-12-05T22:30:00.000Z');

    const code = async (now: Date): Promise<string> => {
      await redis.flushdb();
      try {
        await raiseXCard(deps, p.id, sessionId, now);
        return 'ok';
      } catch (err) {
        return err instanceof AppError ? err.code : String(err);
      }
    };
    expect(await code(new Date(from.getTime() - 1))).toBe('X_CARD_NOT_NOW');
    expect(await code(from)).toBe('ok');
    expect(await code(to)).toBe('ok');
    expect(await code(new Date(to.getTime() + 1))).toBe('X_CARD_NOT_NOW');
  });
});

describe('SessionDto.xCard', () => {
  it('true only for an active member of a game with x_card', async () => {
    const { gm, p, gameId } = await setup();
    const mine = await call('get', `/api/games/${gameId}/sessions`, p.cookie);
    expect(mine.body.every((s: { xCard: boolean }) => s.xCard)).toBe(true);
    const gms = await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    expect(gms.body.some((s: { xCard: boolean }) => s.xCard)).toBe(false);

    await resetDb(db);
    const off = await setup(['session_zero']);
    const none = await call('get', `/api/games/${off.gameId}/sessions`, off.p.cookie);
    expect(none.body.some((s: { xCard: boolean }) => s.xCard)).toBe(false);
  });

  it('RSVP reload carries xCard for the member', async () => {
    const { p, sessionId } = await setup(['x_card'], false);
    const res = await call('put', `/api/sessions/${sessionId}/rsvp`, p.cookie, {
      status: 'going',
    });
    expect(res.status).toBe(200);
    expect(res.body.xCard).toBe(true);
  });
});
