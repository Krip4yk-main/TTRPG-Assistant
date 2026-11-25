import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { asc, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  gameApplications,
  gameMembers,
  gameSessions,
  sessionRsvp,
  users,
} from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
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

const APPLY = { warningsAccepted: true, answers: [] as string[] };
const DAY = 86_400_000;

const action = (body: Record<string, unknown>, key: string | null = KEY) => {
  const r = request(app).post('/api/internal/telegram/action');
  if (key !== null) r.set('X-Internal-Key', key);
  return r.send(body);
};

async function linkTelegram(userId: number, tgId: string): Promise<void> {
  await db.insert(authIdentities).values({ userId, provider: 'telegram', subject: tgId });
}

const appStatus = async (id: number) =>
  (await db.select().from(gameApplications).where(eq(gameApplications.id, id)))[0]!.status;

/** Гра майстра з Telegram 9001 і заявка гравця. */
async function withApplication() {
  const gm = await userWithAge(30, 'Майстер');
  await linkTelegram(gm.id, '9001');
  const p = await userWithAge(25, 'Гравець');
  const gameId = await createGame(gm.cookie, {}, true);
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
  expect(a.status).toBe(201);
  return { gm, p, gameId, appId: a.body.id as number };
}

describe('POST /api/internal/telegram/action — applications (Review Focus 3)', () => {
  it('requires the internal key', async () => {
    const { appId } = await withApplication();
    expect((await action({ telegramId: '9001', action: 'approve', id: appId }, null)).status).toBe(
      401,
    );
    expect((await action({ telegramId: '9001', action: 'approve', id: appId }, 'x')).status).toBe(
      401,
    );
    expect(await appStatus(appId)).toBe('pending');
  });

  it('GM approves from Telegram: member added; repeat press is idempotent', async () => {
    const { p, gameId, appId } = await withApplication();
    const res = await action({ telegramId: '9001', action: 'approve', id: appId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: 'approved' });
    expect(await appStatus(appId)).toBe('approved');
    const again = await action({ telegramId: 9001, action: 'approve', id: appId });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, result: 'approved' });
    const members = await db.select().from(gameMembers).where(eq(gameMembers.gameId, gameId));
    expect(members.map((m) => m.userId)).toEqual([p.id]);
  });

  it('GM rejects (no reason needed); repeat press returns the current state', async () => {
    const { appId } = await withApplication();
    const res = await action({ telegramId: '9001', action: 'reject', id: appId });
    expect(res.body).toEqual({ ok: true, result: 'rejected' });
    expect(await appStatus(appId)).toBe('rejected');
    // «Затвердити» на вже відхиленій заявці — не затверджує, повертає поточний стан.
    const late = await action({ telegramId: '9001', action: 'approve', id: appId });
    expect(late.body).toEqual({ ok: true, result: 'rejected' });
    expect(await appStatus(appId)).toBe('rejected');
  });

  it('foreign Telegram account (not the GM) → 403, application unchanged', async () => {
    const { p, appId } = await withApplication();
    const stranger = await userWithAge(30, 'Чужий');
    await linkTelegram(stranger.id, '9002');
    await linkTelegram(p.id, '9003');
    for (const tg of ['9002', '9003']) {
      for (const act of ['approve', 'reject']) {
        const res = await action({ telegramId: tg, action: act, id: appId });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    }
    expect(await appStatus(appId)).toBe('pending');
  });

  it('unknown Telegram id → 404 NOT_LINKED, application unchanged', async () => {
    const { appId } = await withApplication();
    const res = await action({ telegramId: '123456', action: 'approve', id: appId });
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', details: { reason: 'NOT_LINKED' } });
    expect(await appStatus(appId)).toBe('pending');
  });

  it('banned or pending GM account → 403, application unchanged', async () => {
    const { gm, appId } = await withApplication();
    await db.update(users).set({ isBanned: true }).where(eq(users.id, gm.id));
    const banned = await action({ telegramId: '9001', action: 'approve', id: appId });
    expect(banned.status).toBe(403);
    expect(banned.body.error.code).toBe('ACCOUNT_BANNED');
    await db.update(users).set({ isBanned: false, status: 'pending' }).where(eq(users.id, gm.id));
    const pending = await action({ telegramId: '9001', action: 'approve', id: appId });
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe('PROFILE_INCOMPLETE');
    expect(await appStatus(appId)).toBe('pending');
  });

  it('unknown application → 404; withdrawn application → 409 APPLICATION_CLOSED', async () => {
    const { p, appId } = await withApplication();
    expect((await action({ telegramId: '9001', action: 'approve', id: 999_999 })).status).toBe(404);
    await call('delete', `/api/applications/${appId}`, p.cookie);
    expect(await appStatus(appId)).toBe('withdrawn');
    const res = await action({ telegramId: '9001', action: 'approve', id: appId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPLICATION_CLOSED');
  });

  it('validates the body', async () => {
    for (const body of [
      {},
      { telegramId: '9001', action: 'delete', id: 1 },
      { telegramId: '9001', action: 'approve', id: 0 },
      { telegramId: '9001', action: 'approve', id: 1, value: 'going' },
      { telegramId: '9001', action: 'rsvp', id: 1 },
      { telegramId: 'abc', action: 'approve', id: 1 },
    ]) {
      expect((await action(body)).status).toBe(400);
    }
  });
});

function kyivAt(daysAhead: number) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), 'Europe/Kyiv');
  const start = zonedToUtc(
    { year: z.year, month: z.month, day: z.day, hour: 19, minute: 0 },
    'Europe/Kyiv',
  );
  return { startsAt: start.toISOString(), weekday: z.weekday };
}

describe('POST /api/internal/telegram/action — rsvp', () => {
  async function withSession() {
    const gm = await userWithAge(30, 'Майстер');
    await linkTelegram(gm.id, '9101');
    const first = kyivAt(2);
    const gameId = await createGame(
      gm.cookie,
      { startsAt: first.startsAt, weekdays: [first.weekday] },
      true,
    );
    const p = await userWithAge(25, 'Гравець');
    await linkTelegram(p.id, '9102');
    const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, APPLY);
    await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    const [s] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt));
    return { gm, p, gameId, sessionId: s!.id };
  }

  it('member RSVPs from Telegram; repeat is idempotent; can change', async () => {
    const { p, sessionId } = await withSession();
    const body = { telegramId: '9102', action: 'rsvp', id: sessionId, value: 'going' };
    expect((await action(body)).body).toEqual({ ok: true, result: 'going' });
    expect((await action(body)).body).toEqual({ ok: true, result: 'going' });
    expect((await action({ ...body, value: 'not_going' })).body).toEqual({
      ok: true,
      result: 'not_going',
    });
    const rows = await db.select().from(sessionRsvp);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: p.id, status: 'not_going' });
  });

  it('GM → 403; former member → 403', async () => {
    const { p, gameId, sessionId } = await withSession();
    const gmRes = await action({
      telegramId: '9101',
      action: 'rsvp',
      id: sessionId,
      value: 'going',
    });
    expect(gmRes.status).toBe(403);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'Не встигаю' });
    const former = await action({
      telegramId: '9102',
      action: 'rsvp',
      id: sessionId,
      value: 'going',
    });
    expect(former.status).toBe(403);
    expect(former.body.error.code).toBe('NOT_A_MEMBER');
    expect(await db.select().from(sessionRsvp)).toHaveLength(0);
  });

  it('past session → 409 SESSION_INVALID_STATE', async () => {
    const { sessionId } = await withSession();
    await db
      .update(gameSessions)
      .set({ startsAt: new Date(Date.now() - 60_000) })
      .where(eq(gameSessions.id, sessionId));
    const res = await action({ telegramId: '9102', action: 'rsvp', id: sessionId, value: 'going' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_INVALID_STATE');
  });
});
