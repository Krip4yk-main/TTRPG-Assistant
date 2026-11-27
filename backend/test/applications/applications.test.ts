import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  events,
  gameApplications,
  gameBans,
  gameMembers,
  games,
  gmBlacklist,
  users,
} from '../../src/db/schema/index.js';
import { deleteAccount } from '../../src/users/users.service.js';
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

const APPLY = { warningsAccepted: true, answers: [] as string[] };

async function setup(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30, 'Gm');
  const gameId = await createGame(gm.cookie, patch, true);
  return { gm, gameId };
}

const apply = (gameId: number, cookie: string, body: object = APPLY) =>
  call('post', `/api/games/${gameId}/applications`, cookie, body);

async function eventTypes(): Promise<string[]> {
  return (await db.select({ type: events.type }).from(events)).map((e) => e.type);
}

describe('POST /api/games/:id/applications', () => {
  it('creates a pending application with constraint ids', async () => {
    const { gameId } = await setup({
      applicationQuestions: ['Досвід?', 'Персонаж?'],
      customWarnings: ['Павуки'],
    });
    const p = await userWithAge(25, 'Player');
    const res = await apply(gameId, p.cookie, {
      warningsAccepted: true,
      answers: ['Багато', 'Ельф'],
      message: 'Привіт',
      constraints: ['Без павуків', 'Пізно не можу'],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      gameId,
      status: 'pending',
      message: 'Привіт',
      answers: ['Багато', 'Ельф'],
      cancelReason: null,
      decidedAt: null,
    });
    expect(res.body.constraints).toHaveLength(2);
    for (const c of res.body.constraints) {
      expect(c.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
      expect(c.response).toBeNull();
    }
    expect(res.body.constraints[0].id).not.toBe(res.body.constraints[1].id);
    expect(await eventTypes()).toContain('application.created');
  });

  it('GM on own game → 403 FORBIDDEN', async () => {
    const { gm, gameId } = await setup();
    const res = await apply(gameId, gm.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('17-year-old on 18+ → 403 AGE_RESTRICTED_APPLY', async () => {
    const { gameId } = await setup({ ageRating: '18+' });
    const kid = await userWithAge(17);
    const res = await apply(gameId, kid.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AGE_RESTRICTED_APPLY');
    const adult = await userWithAge(18);
    expect((await apply(gameId, adult.cookie)).status).toBe(201);
  });

  it('game ban → 403 BANNED_FROM_GAME; GM blacklist → 403 GM_BLACKLISTED', async () => {
    const { gm, gameId } = await setup();
    const banned = await userWithAge(25);
    const black = await userWithAge(25);
    await db.insert(gameBans).values({ gameId, userId: banned.id });
    await db.insert(gmBlacklist).values({ gmUserId: gm.id, userId: black.id });
    const r1 = await apply(gameId, banned.cookie);
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('BANNED_FROM_GAME');
    const r2 = await apply(gameId, black.cookie);
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('GM_BLACKLISTED');
  });

  it('warnings must be accepted and every question answered', async () => {
    const { gameId } = await setup({ applicationQuestions: ['Q1', 'Q2'], customWarnings: ['W'] });
    const p = await userWithAge(25);
    const w = await apply(gameId, p.cookie, { warningsAccepted: false, answers: ['a', 'b'] });
    expect(w.status).toBe(400);
    expect(w.body.error.code).toBe('WARNINGS_NOT_ACCEPTED');
    const a1 = await apply(gameId, p.cookie, { warningsAccepted: true, answers: ['a'] });
    expect(a1.status).toBe(400);
    expect(a1.body.error.code).toBe('ANSWERS_REQUIRED');
    const a2 = await apply(gameId, p.cookie, { warningsAccepted: true, answers: ['a', '  '] });
    expect(a2.status).toBe(400);
    expect(a2.body.error.code).toBe('ANSWERS_REQUIRED');
  });

  it('a game without warnings does not require acceptance', async () => {
    const { gameId } = await setup();
    const p = await userWithAge(25);
    expect((await apply(gameId, p.cookie, { warningsAccepted: false, answers: [] })).status).toBe(
      201,
    );
  });

  it('closed games: draft → 404, finished / started without showWhenFull → 409', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const draft = await createGame(gm.cookie);
    expect((await apply(draft, p.cookie)).status).toBe(404);
    const started = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${started}/start`, gm.cookie);
    const r = await apply(started, p.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('APPLICATION_CLOSED');
    const open = await createGame(gm.cookie, { showWhenFull: true }, true);
    await call('post', `/api/games/${open}/start`, gm.cookie);
    expect((await apply(open, p.cookie)).status).toBe(201);
    await call('post', `/api/games/${started}/finish`, gm.cookie);
    expect((await apply(started, p.cookie)).body.error.code).toBe('APPLICATION_CLOSED');
  });

  it('already a member → 409 APPLICATION_EXISTS', async () => {
    const { gameId } = await setup();
    const p = await userWithAge(25);
    await db.insert(gameMembers).values({ gameId, userId: p.id });
    const res = await apply(gameId, p.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPLICATION_EXISTS');
  });

  it('two concurrent applications → exactly one 201 and one 409 (Review Focus 1)', async () => {
    const { gameId } = await setup();
    const p = await userWithAge(25);
    const results = await Promise.all([apply(gameId, p.cookie), apply(gameId, p.cookie)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('APPLICATION_EXISTS');
    const rows = await db
      .select()
      .from(gameApplications)
      .where(and(eq(gameApplications.gameId, gameId), eq(gameApplications.userId, p.id)));
    expect(rows).toHaveLength(1);
  });

  it('can reapply after rejection and after withdrawal once the cooldown has passed', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    // Кулдаун (1 год / 10 хв) — від `decided_at`; тут зсуваємо його в минуле.
    const past = (id: number) =>
      db
        .update(gameApplications)
        .set({ decidedAt: new Date(Date.now() - 25 * 3_600_000) })
        .where(eq(gameApplications.id, id));
    const first = await apply(gameId, p.cookie);
    const rej = await call('post', `/api/applications/${first.body.id}/reject`, gm.cookie);
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('rejected');
    await past(first.body.id);
    const second = await apply(gameId, p.cookie);
    expect(second.status).toBe(201);
    const wd = await call('delete', `/api/applications/${second.body.id}`, p.cookie);
    expect(wd.status).toBe(200);
    expect(wd.body.status).toBe('withdrawn');
    await past(second.body.id);
    expect((await apply(gameId, p.cookie)).status).toBe(201);
    expect(await eventTypes()).toEqual(
      expect.arrayContaining(['application.rejected', 'application.withdrawn']),
    );
  });
});

describe('withdraw / approve / reject', () => {
  it("withdrawing someone else's application → 404; non-pending → 409", async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const other = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    expect((await call('delete', `/api/applications/${a.body.id}`, other.cookie)).status).toBe(404);
    expect((await call('delete', `/api/applications/${a.body.id}`, gm.cookie)).status).toBe(404);
    await call('post', `/api/applications/${a.body.id}/reject`, gm.cookie);
    const r = await call('delete', `/api/applications/${a.body.id}`, p.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('APPLICATION_CLOSED');
  });

  it('only the GM approves or rejects', async () => {
    const { gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    for (const action of ['approve', 'reject']) {
      const r = await call('post', `/api/applications/${a.body.id}/${action}`, p.cookie);
      expect(r.status).toBe(403);
    }
    expect((await call('post', '/api/applications/999999/approve', p.cookie)).status).toBe(404);
  });

  it('two concurrent approvals → one member (Review Focus 1)', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    const results = await Promise.all([
      call('post', `/api/applications/${a.body.id}/approve`, gm.cookie),
      call('post', `/api/applications/${a.body.id}/approve`, gm.cookie),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const members = await db
      .select()
      .from(gameMembers)
      .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)));
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: p.id, applicationId: a.body.id });
    const ok = results.find((r) => r.status === 200)!;
    expect(ok.body.status).toBe('approved');
    expect(ok.body.decidedAt).toEqual(expect.any(String));
    expect(await eventTypes()).toContain('application.approved');
  });

  it('GM can approve beyond maxPlayers', async () => {
    const { gm, gameId } = await setup({ minPlayers: 1, maxPlayers: 1 });
    const p1 = await userWithAge(25);
    const p2 = await userWithAge(25);
    const a1 = await apply(gameId, p1.cookie);
    const a2 = await apply(gameId, p2.cookie);
    expect((await call('post', `/api/applications/${a1.body.id}/approve`, gm.cookie)).status).toBe(
      200,
    );
    expect((await call('post', `/api/applications/${a2.body.id}/approve`, gm.cookie)).status).toBe(
      200,
    );
    const members = await db.select().from(gameMembers).where(eq(gameMembers.gameId, gameId));
    expect(members).toHaveLength(2);
  });
});

describe('constraints', () => {
  it('GM answers each constraint; partial requires a comment', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie, { ...APPLY, constraints: ['Без павуків'] });
    const cid = a.body.constraints[0].id as string;
    const url = `/api/applications/${a.body.id}/constraints/${cid}`;
    const noComment = await call('put', url, gm.cookie, { response: 'partial' });
    expect(noComment.status).toBe(400);
    expect((await call('put', url, p.cookie, { response: 'accepted' })).status).toBe(403);
    expect(
      (
        await call('put', `/api/applications/${a.body.id}/constraints/nope1234`, gm.cookie, {
          response: 'accepted',
        })
      ).status,
    ).toBe(404);
    const ok = await call('put', url, gm.cookie, { response: 'partial', comment: 'Лише згадки' });
    expect(ok.status).toBe(200);
    expect(ok.body.constraints[0]).toEqual({
      id: cid,
      text: 'Без павуків',
      response: 'partial',
      comment: 'Лише згадки',
    });
    // Після затвердження — теж; відповідь перезаписується.
    await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    const again = await call('put', url, gm.cookie, { response: 'accepted' });
    expect(again.status).toBe(200);
    expect(again.body.constraints[0]).toMatchObject({ response: 'accepted', comment: null });

    const mine = await call('get', '/api/me/applications', p.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].game).toMatchObject({ id: gameId, title: expect.any(String) });
    expect(mine.body[0].constraints[0]).toMatchObject({ response: 'accepted' });
  });
});

describe('GET /api/games/:id/applications', () => {
  it('GM sees applicants with meetsAgeRating, never the birth date', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25, 'Applicant');
    await apply(gameId, p.cookie);
    const res = await call('get', `/api/games/${gameId}/applications`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].applicant).toEqual({
      publicId: p.publicId,
      nickname: 'Applicant',
      avatarUrl: null,
    });
    expect(res.body[0].meetsAgeRating).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(p.birthDate!);
    expect((await call('get', `/api/games/${gameId}/applications`, p.cookie)).status).toBe(403);
  });
});

describe('age rating raise (Review Focus 2)', () => {
  it("raising to 18+ cancels a 17-year-old's pending application", async () => {
    const { gm, gameId } = await setup();
    const kid = await userWithAge(17);
    const adult = await userWithAge(25);
    const k = await apply(gameId, kid.cookie);
    const a = await apply(gameId, adult.cookie);
    const res = await call('patch', `/api/games/${gameId}`, gm.cookie, { ageRating: '18+' });
    expect(res.status).toBe(200);
    const [kr] = await db.select().from(gameApplications).where(eq(gameApplications.id, k.body.id));
    expect(kr).toMatchObject({ status: 'cancelled', cancelReason: 'age_rating' });
    const [ar] = await db.select().from(gameApplications).where(eq(gameApplications.id, a.body.id));
    expect(ar!.status).toBe('pending');
    const ev = await db.select().from(events).where(eq(events.type, 'application.cancelled_age'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: kid.id, entityId: k.body.id });
  });

  it('with a 17-year-old member → 409 AGE_RATING_HAS_MINORS, rating unchanged', async () => {
    const { gm, gameId } = await setup();
    const kid = await userWithAge(17);
    const k = await apply(gameId, kid.cookie);
    await call('post', `/api/applications/${k.body.id}/approve`, gm.cookie);
    const res = await call('patch', `/api/games/${gameId}`, gm.cookie, { ageRating: '18+' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AGE_RATING_HAS_MINORS');
    const [g] = await db.select().from(games).where(eq(games.id, gameId));
    expect(g!.ageRating).toBe('none');
  });
});

describe('game cancellation', () => {
  it('cancels pending applications with reason game_cancelled', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    expect((await call('post', `/api/games/${gameId}/cancel`, gm.cookie)).status).toBe(200);
    const [row] = await db
      .select()
      .from(gameApplications)
      .where(eq(gameApplications.id, a.body.id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'game_cancelled' });
    expect(await eventTypes()).toContain('application.cancelled_game');
  });
});

describe('Task 3 carry-overs', () => {
  it('site-banned applicant: apply → 403 ACCOUNT_BANNED; approve → 409 APPLICATION_CLOSED', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const q = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    await db
      .update(users)
      .set({ isBanned: true })
      .where(inArray(users.id, [p.id, q.id]));
    const r = await apply(gameId, q.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_BANNED');
    const ap = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('APPLICATION_CLOSED');
    expect(await db.select().from(gameMembers)).toHaveLength(0);
  });

  it('approve of a deleted applicant → 409, no member', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    await deleteAccount(deps, p.id);
    const ap = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    expect(ap.status).toBe(409);
    expect(await db.select().from(gameMembers)).toHaveLength(0);
  });

  it('deleteAccount concurrent with approve: no deadlock, never a deleted member', async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb(db);
      const { gm, gameId } = await setup();
      const p = await userWithAge(25);
      const a = await apply(gameId, p.cookie);
      const [del, ap] = await Promise.allSettled([
        deleteAccount(deps, p.id),
        call('post', `/api/applications/${a.body.id}/approve`, gm.cookie),
      ]);
      expect(del.status).toBe('fulfilled');
      expect(ap.status).toBe('fulfilled');
      expect([200, 409]).toContain((ap as PromiseFulfilledResult<{ status: number }>).value.status);
      expect(
        await db
          .select()
          .from(gameMembers)
          .where(and(eq(gameMembers.userId, p.id), isNull(gameMembers.leftAt))),
      ).toHaveLength(0);
    }
  }, 30_000);

  it('GM deleting the account while approving in own game: no deadlock', async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb(db);
      const { gm, gameId } = await setup();
      const p = await userWithAge(25);
      const a = await apply(gameId, p.cookie);
      const [del, ap] = await Promise.allSettled([
        deleteAccount(deps, gm.id),
        call('post', `/api/applications/${a.body.id}/approve`, gm.cookie),
      ]);
      expect(del.status).toBe('fulfilled');
      expect(ap.status).toBe('fulfilled');
      expect([200, 401, 409]).toContain(
        (ap as PromiseFulfilledResult<{ status: number }>).value.status,
      );
      const [g] = await db.select().from(games).where(eq(games.id, gameId));
      expect(g!.status).toBe('cancelled');
    }
  }, 30_000);

  it('cancelled never-published game: applications list → 404 for non-GM', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const id = await createGame(gm.cookie);
    await call('post', `/api/games/${id}/cancel`, gm.cookie);
    expect((await call('get', `/api/games/${id}/applications`, other.cookie)).status).toBe(404);
    expect((await call('get', `/api/games/${id}/applications`, gm.cookie)).status).toBe(200);
  });

  it('age-restricted closed game: a minor gets AGE_RESTRICTED_APPLY, not APPLICATION_CLOSED', async () => {
    const { gm, gameId } = await setup({ ageRating: '18+' });
    await call('post', `/api/games/${gameId}/start`, gm.cookie);
    const kid = await userWithAge(17);
    const r = await apply(gameId, kid.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('AGE_RESTRICTED_APPLY');
    const adult = await userWithAge(25);
    expect((await apply(gameId, adult.cookie)).body.error.code).toBe('APPLICATION_CLOSED');
  });
});

describe('GET /api/games/mine — pending counts (Task 9)', () => {
  it('carries pendingApplications, memberCount and minPlayers for each own game', async () => {
    const { gm, gameId } = await setup();
    const other = await createGame(gm.cookie, {}, true);
    const a = await userWithAge(25);
    const b = await userWithAge(25);
    const c = await userWithAge(25);
    await apply(gameId, a.cookie);
    await apply(gameId, b.cookie);
    const approved = await apply(gameId, c.cookie);
    await call('post', `/api/applications/${approved.body.id}/approve`, gm.cookie);
    const res = await call('get', '/api/games/mine', gm.cookie);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((g: { id: number }) => [g.id, g]));
    expect(byId.get(gameId)).toMatchObject({ pendingApplications: 2, memberCount: 1 });
    expect(byId.get(gameId)).toHaveProperty('minPlayers', expect.any(Number));
    expect(byId.get(other)).toMatchObject({ pendingApplications: 0, memberCount: 0 });
  });
});
