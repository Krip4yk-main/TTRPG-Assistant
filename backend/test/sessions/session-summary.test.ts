import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { notificationLink, toZoned, zonedToUtc, type SessionDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  gameMembers,
  gameSessions,
  notifications,
  telegramOutbox,
} from '../../src/db/schema/index.js';
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

const DAY = 86_400_000;
const HOUR = 3_600_000;
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

const setMembership = (gameId: number, userId: number, v: { joinedAt?: Date; leftAt?: Date }) =>
  db
    .update(gameMembers)
    .set(v)
    .where(and(eq(gameMembers.gameId, gameId), eq(gameMembers.userId, userId)));

const summaryNotes = (userId?: number) =>
  db
    .select()
    .from(notifications)
    .where(
      userId === undefined
        ? eq(notifications.type, 'session.summary')
        : and(eq(notifications.type, 'session.summary'), eq(notifications.userId, userId)),
    );

const LEAVE = { noteForGm: 'Не встигаю за розкладом' };
const LONG = `${'Герої дісталися замку. '.repeat(20)}Кінець.`;

/**
 * Кампанія з минулою сесією (3 год тому): p1 — учасник з дня до сесії й досі; p2 — вийшов до
 * сесії; p4 — був на сесії, вийшов після. p3 вступає вже після сесії (`lateJoiner`).
 */
async function party(opts: { finish?: Record<string, unknown> | false } = {}) {
  const gm = await userWithAge(30);
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday] },
    true,
  );
  const [p1, p2, p3, p4] = await Promise.all([25, 25, 25, 25].map((a) => userWithAge(a)));
  for (const p of [p1!, p2!, p4!]) await join(gm, gameId, p);
  const [s] = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));
  const startsAt = new Date(Math.floor((Date.now() - 3 * HOUR) / 60_000) * 60_000);
  await db.update(gameSessions).set({ startsAt }).where(eq(gameSessions.id, s!.id));
  const before = new Date(startsAt.getTime() - DAY);
  for (const p of [p1!, p2!, p4!]) await setMembership(gameId, p.id, { joinedAt: before });
  expect((await call('post', `/api/games/${gameId}/leave`, p2!.cookie, LEAVE)).status).toBe(204);
  await setMembership(gameId, p2!.id, { leftAt: new Date(startsAt.getTime() - HOUR) });
  if (opts.finish !== false) {
    const res = await call('post', `/api/sessions/${s!.id}/finish`, gm.cookie, {
      attendance: [
        { publicId: p1!.publicId, present: true },
        { publicId: p4!.publicId, present: true },
      ],
      summary: LONG,
      ...opts.finish,
    });
    expect(res.status).toBe(200);
  }
  await join(gm, gameId, p3!);
  expect((await call('post', `/api/games/${gameId}/leave`, p4!.cookie, LEAVE)).status).toBe(204);
  return { gm, gameId, sessionId: s!.id, startsAt, p1: p1!, p2: p2!, p3: p3!, p4: p4! };
}

describe('PUT /api/sessions/:id/summary', () => {
  it('only the GM edits the summary of a done session', async () => {
    const { gm, sessionId, p1, p3 } = await party();
    const ok = await call('put', `/api/sessions/${sessionId}/summary`, gm.cookie, {
      summary: '  Новий підсумок  ',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ summary: 'Новий підсумок', summarySentAt: null });
    const member = await call('put', `/api/sessions/${sessionId}/summary`, p1.cookie, {
      summary: 'x',
    });
    expect(member.status).toBe(403);
    expect(
      (await call('put', `/api/sessions/${sessionId}/summary`, p3.cookie, { summary: 'x' })).status,
    ).toBe(403);
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row!.summary).toBe('Новий підсумок');
  });

  it('clearing with null/empty is allowed; too long → 400; not done → 409', async () => {
    const { gm, gameId, sessionId } = await party();
    const cleared = await call('put', `/api/sessions/${sessionId}/summary`, gm.cookie, {
      summary: '  ',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.summary).toBeNull();
    const long = await call('put', `/api/sessions/${sessionId}/summary`, gm.cookie, {
      summary: 'x'.repeat(10_001),
    });
    expect(long.status).toBe(400);
    const [, next] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt));
    const scheduled = await call('put', `/api/sessions/${next!.id}/summary`, gm.cookie, {
      summary: 'x',
    });
    expect(scheduled.status).toBe(409);
    expect(scheduled.body.error.code).toBe('SESSION_INVALID_STATE');
  });
});

describe('POST /api/sessions/:id/summary/send', () => {
  it('notifies members at the session time only; once; edits do not resend', async () => {
    const { gm, gameId, sessionId, startsAt, p1, p2, p3, p4 } = await party();
    await db.insert(authIdentities).values([
      { userId: p1.id, provider: 'telegram', subject: '9101' },
      { userId: gm.id, provider: 'telegram', subject: '9100' },
    ]);
    const res = await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body.summarySentAt).toEqual(expect.any(String));

    const rows = await summaryNotes();
    expect(rows.map((r) => r.userId).sort()).toEqual([p1.id, p4.id].sort());
    for (const u of [gm, p2, p3]) expect(await summaryNotes(u.id)).toHaveLength(0);
    const [n] = await summaryNotes(p1.id);
    expect(n!.category).toBe('schedule');
    expect(n!.payload).toMatchObject({
      gameId,
      gameTitle: 'Прокляття Страда',
      sessionId,
      startsAt: startsAt.toISOString(),
    });
    const excerpt = (n!.payload as { excerpt: string }).excerpt;
    expect(excerpt.endsWith('…')).toBe(true);
    expect([...excerpt].length).toBeLessThanOrEqual(301);
    expect(LONG.startsWith(excerpt.slice(0, -1).trimEnd())).toBe(true);
    expect(notificationLink('session.summary', n!.payload)).toBe(`/games/${gameId}`);
    // Telegram — лише прив'язаному учаснику (майстру нічого).
    const outbox = await db.select().from(telegramOutbox);
    expect(outbox.map((o) => o.notificationId)).toEqual([n!.id]);

    const again = await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUMMARY_ALREADY_SENT');
    const edit = await call('put', `/api/sessions/${sessionId}/summary`, gm.cookie, {
      summary: 'Виправлений підсумок',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.summarySentAt).toBe(res.body.summarySentAt);
    expect(await summaryNotes()).toHaveLength(2);
  });

  it('member → 403; empty summary → 422; scheduled session → 409', async () => {
    const { gm, gameId, sessionId, p1 } = await party({ finish: { summary: null } });
    const member = await call('post', `/api/sessions/${sessionId}/summary/send`, p1.cookie);
    expect(member.status).toBe(403);
    const empty = await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie);
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('SUMMARY_EMPTY');
    const [, next] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt));
    const scheduled = await call('post', `/api/sessions/${next!.id}/summary/send`, gm.cookie);
    expect(scheduled.status).toBe(409);
    expect(await summaryNotes()).toHaveLength(0);
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row!.summarySentAt).toBeNull();
  });

  it('a member who muted «Розклад» on the site gets nothing', async () => {
    const { gm, sessionId, p1, p4 } = await party();
    const prefs = (await call('get', '/api/me/notification-prefs', p1.cookie)).body;
    const put = await call('put', '/api/me/notification-prefs', p1.cookie, {
      ...prefs,
      site: { schedule: false },
    });
    expect(put.status).toBe(200);
    expect((await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie)).status).toBe(
      200,
    );
    expect((await summaryNotes()).map((r) => r.userId)).toEqual([p4.id]);
  });

  it('a member banned from the game after the session gets nothing', async () => {
    const { gm, gameId, sessionId, p1, p4 } = await party();
    const ban = await call('post', `/api/games/${gameId}/members/${p1.publicId}/ban`, gm.cookie);
    expect(ban.status).toBe(204);
    expect((await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie)).status).toBe(
      200,
    );
    expect((await summaryNotes()).map((r) => r.userId)).toEqual([p4.id]);
  });

  it('a short summary is sent whole, without «…»', async () => {
    const { gm, sessionId, p1 } = await party({ finish: { summary: 'Коротко' } });
    await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie);
    const [n] = await summaryNotes(p1.id);
    expect((n!.payload as { excerpt: string }).excerpt).toBe('Коротко');
  });
});

describe('finish with sendSummary', () => {
  it('sends at once to members at the session time; a later send → 409', async () => {
    const { gm, sessionId, p1, p4 } = await party({ finish: { sendSummary: true } });
    expect((await summaryNotes()).map((r) => r.userId).sort()).toEqual([p1.id, p4.id].sort());
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row!.summarySentAt).not.toBeNull();
    const again = await call('post', `/api/sessions/${sessionId}/summary/send`, gm.cookie);
    expect(again.status).toBe(409);
  });

  it('sendSummary without a summary → 422, the session stays scheduled', async () => {
    const { gm, sessionId, p1 } = await party({ finish: false });
    const res = await call('post', `/api/sessions/${sessionId}/finish`, gm.cookie, {
      attendance: [{ publicId: p1.publicId, present: true }],
      summary: '   ',
      sendSummary: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SUMMARY_EMPTY');
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row!.status).toBe('scheduled');
  });

  it('without sendSummary nothing is sent', async () => {
    const { sessionId } = await party();
    expect(await summaryNotes()).toHaveLength(0);
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    expect(row!.summarySentAt).toBeNull();
  });
});

describe('summary visibility', () => {
  it('GM and current members see it; strangers, former members, guests and SEO do not', async () => {
    const { gm, gameId, sessionId, p1, p3, p4 } = await party({
      finish: { summary: 'Таємний підсумок' },
    });
    const stranger = await userWithAge(25);
    for (const u of [gm, p1, p3]) {
      const list = await call('get', `/api/games/${gameId}/sessions`, u.cookie);
      expect(list.status).toBe(200);
      expect(list.body.find((x: SessionDto) => x.id === sessionId).summary).toBe(
        'Таємний підсумок',
      );
    }
    for (const u of [stranger, p4]) {
      expect((await call('get', `/api/games/${gameId}/sessions`, u.cookie)).status).toBe(403);
      const game = await call('get', `/api/games/${gameId}`, u.cookie);
      expect(JSON.stringify(game.body)).not.toContain('Таємний');
    }
    expect((await call('get', `/api/games/${gameId}/sessions`)).status).toBe(401);
    const guest = await call('get', `/api/games/${gameId}`);
    expect(JSON.stringify(guest.body)).not.toContain('Таємний');
    const og = await request(app).get(`/api/og/games/${gameId}`);
    expect(og.text).not.toContain('Таємний');
    // RSVP-відповідь учасника (reload) теж іде лише через перевірку доступу.
    expect(
      (await call('put', `/api/sessions/${sessionId}/rsvp`, stranger.cookie, { status: 'going' }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  });
});
