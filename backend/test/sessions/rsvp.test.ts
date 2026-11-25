import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc, type SessionDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { games, gameSessions, sessionRsvp } from '../../src/db/schema/index.js';
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

/** Щотижнева кампанія (перша сесія через 2 доби) з одним учасником. */
async function setup() {
  const gm = await userWithAge(30, 'Майстер');
  const first = kyivAt(2);
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.startsAt, weekdays: [first.weekday] },
    true,
  );
  const p = await userWithAge(25, 'Гравець');
  await join(gm, gameId, p);
  const [s] = await db
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.gameId, gameId))
    .orderBy(asc(gameSessions.startsAt));
  return { gm, p, gameId, sessionId: s!.id };
}

const rsvp = (sessionId: number, cookie: string | undefined, status: unknown) =>
  call('put', `/api/sessions/${sessionId}/rsvp`, cookie, { status });

const rsvpRows = () => db.select().from(sessionRsvp);

describe('PUT /api/sessions/:id/rsvp', () => {
  it('active member answers; repeat is idempotent; can change; DTO carries myRsvp', async () => {
    const { p, sessionId } = await setup();
    const res = await rsvp(sessionId, p.cookie, 'going');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: sessionId, myRsvp: 'going', rsvpSummary: null });
    expect((await rsvp(sessionId, p.cookie, 'going')).status).toBe(200);
    expect(await rsvpRows()).toHaveLength(1);
    const changed = await rsvp(sessionId, p.cookie, 'not_going');
    expect(changed.body.myRsvp).toBe('not_going');
    const rows = await rsvpRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId, userId: p.id, status: 'not_going' });
  });

  it('validates the body', async () => {
    const { p, sessionId } = await setup();
    expect((await rsvp(sessionId, p.cookie, 'maybe')).status).toBe(400);
    expect((await call('put', `/api/sessions/${sessionId}/rsvp`, p.cookie, {})).status).toBe(400);
  });

  it('GM cannot RSVP (403 FORBIDDEN); guest — 401', async () => {
    const { gm, sessionId } = await setup();
    const res = await rsvp(sessionId, gm.cookie, 'going');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await rsvp(sessionId, undefined, 'going')).status).toBe(401);
    expect(await rsvpRows()).toHaveLength(0);
  });

  it('stranger and former member → 403 NOT_A_MEMBER', async () => {
    const { gameId, p, sessionId } = await setup();
    const stranger = await userWithAge(25);
    const s = await rsvp(sessionId, stranger.cookie, 'going');
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('NOT_A_MEMBER');
    await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'Не встигаю' });
    const f = await rsvp(sessionId, p.cookie, 'going');
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe('NOT_A_MEMBER');
    expect(await rsvpRows()).toHaveLength(0);
  });

  it('past or cancelled session → 409 SESSION_INVALID_STATE; unknown → 404', async () => {
    const { gm, p, sessionId } = await setup();
    await call('post', `/api/sessions/${sessionId}/cancel`, gm.cookie, { reason: 'Хворію' });
    const c = await rsvp(sessionId, p.cookie, 'going');
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('SESSION_INVALID_STATE');
    const [other] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.status, 'scheduled'))
      .orderBy(asc(gameSessions.startsAt));
    await db
      .update(gameSessions)
      .set({ startsAt: new Date(Date.now() - 3_600_000) })
      .where(eq(gameSessions.id, other!.id));
    const past = await rsvp(other!.id, p.cookie, 'going');
    expect(past.status).toBe(409);
    expect(past.body.error.code).toBe('SESSION_INVALID_STATE');
    expect((await rsvp(999_999, p.cookie, 'going')).status).toBe(404);
    expect(await rsvpRows()).toHaveLength(0);
  });

  it('finished/cancelled game → 409 GAME_INVALID_TRANSITION', async () => {
    const { gameId, p, sessionId } = await setup();
    await db.update(games).set({ status: 'finished' }).where(eq(games.id, gameId));
    const res = await rsvp(sessionId, p.cookie, 'going');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAME_INVALID_TRANSITION');
  });
});

describe('SessionDto rsvp fields', () => {
  it('summary only in the GM DTO; members see only their own answer', async () => {
    const { gm, p, gameId, sessionId } = await setup();
    const p2 = await userWithAge(26, 'Другий');
    await join(gm, gameId, p2);
    await rsvp(sessionId, p.cookie, 'going');

    const forGm = await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const s = (forGm.body as SessionDto[]).find((x) => x.id === sessionId)!;
    expect(s.myRsvp).toBeNull();
    expect(s.rsvpSummary).toEqual({
      going: 1,
      notGoing: 0,
      members: [
        { publicId: p.publicId, nickname: 'Гравець', status: 'going' },
        { publicId: p2.publicId, nickname: 'Другий', status: null },
      ],
    });

    const forP = await call('get', `/api/games/${gameId}/sessions`, p.cookie);
    const mine = (forP.body as SessionDto[]).find((x) => x.id === sessionId)!;
    expect(mine.myRsvp).toBe('going');
    expect(mine.rsvpSummary).toBeNull();
    const forP2 = await call('get', `/api/games/${gameId}/sessions`, p2.cookie);
    for (const x of forP2.body as SessionDto[]) {
      expect(x.rsvpSummary).toBeNull();
      expect(x.myRsvp).toBeNull();
    }
    expect(JSON.stringify(forP2.body)).not.toContain(p.publicId);
  });

  it('former member answers drop out of the summary', async () => {
    const { gm, p, gameId, sessionId } = await setup();
    await rsvp(sessionId, p.cookie, 'not_going');
    await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'Не встигаю' });
    const res = await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const s = (res.body as SessionDto[]).find((x) => x.id === sessionId)!;
    expect(s.rsvpSummary).toEqual({ going: 0, notGoing: 0, members: [] });
  });

  it('GM actions return the DTO with the summary', async () => {
    const { gm, p, sessionId } = await setup();
    await rsvp(sessionId, p.cookie, 'going');
    const res = await call('post', `/api/sessions/${sessionId}/cancel`, gm.cookie, {
      reason: 'Майстер захворів',
    });
    expect(res.status).toBe(200);
    expect(res.body.rsvpSummary).toMatchObject({ going: 1, notGoing: 0 });
  });

  it('reschedule clears the answers (they were for the old time); others stay', async () => {
    const { gm, p, gameId, sessionId } = await setup();
    const [other] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt))
      .limit(1)
      .offset(1);
    await rsvp(sessionId, p.cookie, 'going');
    await rsvp(other!.id, p.cookie, 'not_going');
    const res = await call('post', `/api/sessions/${sessionId}/reschedule`, gm.cookie, {
      startsAt: kyivAt(5, 18).startsAt,
    });
    expect(res.status).toBe(200);
    expect(res.body.rsvpSummary).toMatchObject({ going: 0, notGoing: 0 });
    const left = await db.select().from(sessionRsvp);
    expect(left.map((r) => r.sessionId)).toEqual([other!.id]);
    const mine = await call('get', `/api/games/${gameId}/sessions`, p.cookie);
    expect((mine.body as SessionDto[]).find((x) => x.id === sessionId)!.myRsvp).toBeNull();
  });
});
