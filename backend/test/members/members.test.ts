import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  events,
  gameApplications,
  gameBans,
  gameMembers,
  gmBlacklist,
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

const APPLY = { warningsAccepted: true, answers: [] as string[] };
const LEAVE = { noteForGm: 'Не встигаю за розкладом' };

type User = Awaited<ReturnType<typeof userWithAge>>;

const apply = (gameId: number, cookie: string) =>
  call('post', `/api/games/${gameId}/applications`, cookie, APPLY);

/** Гравець подає заявку, майстер затверджує. */
async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await apply(gameId, p.cookie);
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  const ok = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status} ${JSON.stringify(ok.body)}`);
}

async function setup(patch: Record<string, unknown> = {}, nickname?: string) {
  const gm = await userWithAge(30, nickname);
  const gameId = await createGame(gm.cookie, patch, true);
  return { gm, gameId };
}

async function eventsOf(type: string) {
  return db.select().from(events).where(eq(events.type, type));
}

async function activeMembers(gameId: number) {
  return db
    .select()
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)));
}

describe('GET /api/games/:id/members', () => {
  it('GM and active members see the roster; strangers and former members — 403', async () => {
    const { gm, gameId } = await setup();
    const p1 = await userWithAge(25, 'Alpha');
    const p2 = await userWithAge(25, 'Beta');
    const stranger = await userWithAge(25);
    await join(gm, gameId, p1);
    await join(gm, gameId, p2);
    const res = await call('get', `/api/games/${gameId}/members`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { publicId: p1.publicId, nickname: 'Alpha', avatarUrl: null, joinedAt: expect.any(String) },
      { publicId: p2.publicId, nickname: 'Beta', avatarUrl: null, joinedAt: expect.any(String) },
    ]);
    expect((await call('get', `/api/games/${gameId}/members`, p1.cookie)).status).toBe(200);
    const s = await call('get', `/api/games/${gameId}/members`, stranger.cookie);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('NOT_A_MEMBER');
    expect((await call('get', `/api/games/${gameId}/members`)).status).toBe(401);
    await call('post', `/api/games/${gameId}/leave`, p1.cookie, LEAVE);
    expect((await call('get', `/api/games/${gameId}/members`, p1.cookie)).status).toBe(403);
    const after = await call('get', `/api/games/${gameId}/members`, gm.cookie);
    expect(after.body.map((m: { publicId: string }) => m.publicId)).toEqual([p2.publicId]);
  });

  it("someone else's draft → 404", async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const draft = await createGame(gm.cookie);
    expect((await call('get', `/api/games/${draft}/members`, other.cookie)).status).toBe(404);
  });
});

describe('«Мої межі» — приватність', () => {
  it('the limits marker never appears in the members list or in search results', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25, 'Alpha');
    await join(gm, gameId, p);
    const marker = 'унікальний-маркер-меж-7731';
    expect((await call('put', '/api/me/limits', p.cookie, { limits: [marker] })).status).toBe(200);
    const roster = await call('get', `/api/games/${gameId}/members`, gm.cookie);
    expect(roster.status).toBe(200);
    expect(JSON.stringify(roster.body)).not.toContain(marker);
    const asMember = await call('get', `/api/games/${gameId}/members`, p.cookie);
    expect(JSON.stringify(asMember.body)).not.toContain(marker);
    const found = await call('post', '/api/games/search', gm.cookie, {});
    expect(found.status).toBe(200);
    expect(found.body.items.map((i: { id: number }) => i.id)).toContain(gameId);
    expect(JSON.stringify(found.body)).not.toContain(marker);
  });
});

describe('POST /api/games/:id/leave', () => {
  it('without noteForGm (or shorter than 10) → 400', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    expect((await call('post', `/api/games/${gameId}/leave`, p.cookie, {})).status).toBe(400);
    expect(
      (await call('post', `/api/games/${gameId}/leave`, p.cookie, { noteForGm: 'коротко' })).status,
    ).toBe(400);
    expect(await activeMembers(gameId)).toHaveLength(1);
  });

  it('empty noteForAdmin defaults to noteForGm; member.left event', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const res = await call('post', `/api/games/${gameId}/leave`, p.cookie, {
      ...LEAVE,
      noteForAdmin: '',
    });
    expect(res.status).toBe(204);
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m).toMatchObject({
      leftReason: 'left',
      leaveNoteGm: LEAVE.noteForGm,
      leaveNoteAdmin: LEAVE.noteForGm,
    });
    expect(m!.leftAt).toBeInstanceOf(Date);
    const ev = await eventsOf('member.left');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: p.id, entityType: 'game', entityId: gameId });
  });

  it('a separate noteForAdmin is kept', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, {
      ...LEAVE,
      noteForAdmin: 'Майстер грубий',
    });
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m!.leaveNoteAdmin).toBe('Майстер грубий');
  });

  it('non-member → 403 NOT_A_MEMBER; can reapply after leaving', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const r = await call('post', `/api/games/${gameId}/leave`, p.cookie, LEAVE);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_A_MEMBER');
    expect((await call('post', `/api/games/${gameId}/leave`, gm.cookie, LEAVE)).status).toBe(403);
    await join(gm, gameId, p);
    await call('post', `/api/games/${gameId}/leave`, p.cookie, LEAVE);
    expect((await apply(gameId, p.cookie)).status).toBe(201);
  });
});

describe('kick / ban', () => {
  it('kicked member can apply again', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const res = await call('post', `/api/games/${gameId}/members/${p.publicId}/kick`, gm.cookie);
    expect(res.status).toBe(204);
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m!.leftReason).toBe('kicked');
    expect(m!.leftAt).toBeInstanceOf(Date);
    expect(await eventsOf('member.kicked')).toHaveLength(1);
    expect((await apply(gameId, p.cookie)).status).toBe(201);
  });

  it('banned member cannot apply again', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const res = await call('post', `/api/games/${gameId}/members/${p.publicId}/ban`, gm.cookie);
    expect(res.status).toBe(204);
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, p.id));
    expect(m!.leftReason).toBe('banned');
    expect(await db.select().from(gameBans)).toHaveLength(1);
    expect(await eventsOf('member.banned')).toHaveLength(1);
    const r = await apply(gameId, p.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BANNED_FROM_GAME');
  });

  it("ban cancels the user's pending application (banned)", async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    const res = await call('post', `/api/games/${gameId}/members/${p.publicId}/ban`, gm.cookie);
    expect(res.status).toBe(204);
    const [row] = await db
      .select()
      .from(gameApplications)
      .where(eq(gameApplications.id, a.body.id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'banned' });
  });

  it('only the GM kicks/bans; unknown or non-member target → 404', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const other = await userWithAge(25);
    await join(gm, gameId, p);
    const r = await call('post', `/api/games/${gameId}/members/${p.publicId}/kick`, other.cookie);
    expect(r.status).toBe(403);
    expect(
      (await call('post', `/api/games/${gameId}/members/${p.publicId}/ban`, p.cookie)).status,
    ).toBe(403);
    expect(
      (await call('post', `/api/games/${gameId}/members/${other.publicId}/kick`, gm.cookie)).status,
    ).toBe(404);
    expect(
      (await call('post', `/api/games/${gameId}/members/nobody0000/ban`, gm.cookie)).status,
    ).toBe(404);
    expect(await activeMembers(gameId)).toHaveLength(1);
  });

  it('ban then approve of an earlier application → approve fails, no member', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    await call('post', `/api/games/${gameId}/members/${p.publicId}/ban`, gm.cookie);
    const r = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    expect(r.status).toBe(409);
    expect(await activeMembers(gameId)).toHaveLength(0);
  });

  it('approve re-checks game_bans under the game lock (ban row without cancelled app)', async () => {
    const { gm, gameId } = await setup();
    const p = await userWithAge(25);
    const a = await apply(gameId, p.cookie);
    await db.insert(gameBans).values({ gameId, userId: p.id });
    const r = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BANNED_FROM_GAME');
    expect(await activeMembers(gameId)).toHaveLength(0);
  });

  it('concurrent ban and approve → never a banned active member', async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb(db);
      const { gm, gameId } = await setup();
      const p = await userWithAge(25);
      const a = await apply(gameId, p.cookie);
      const [ban, appr] = await Promise.all([
        call('post', `/api/games/${gameId}/members/${p.publicId}/ban`, gm.cookie),
        call('post', `/api/applications/${a.body.id}/approve`, gm.cookie),
      ]);
      expect(ban.status).toBe(204);
      expect([200, 403, 409]).toContain(appr.status);
      expect(await activeMembers(gameId)).toHaveLength(0);
      expect(await db.select().from(gameBans)).toHaveLength(1);
    }
  }, 30_000);
});

describe('/api/me/blacklist', () => {
  it('blacklist blocks applications to another game of the same GM, not to other GMs', async () => {
    const { gm, gameId } = await setup();
    const other = await setup();
    const p = await userWithAge(25, 'Troll');
    await join(gm, gameId, p);
    const add = await call('post', `/api/me/blacklist/${p.publicId}`, gm.cookie);
    expect(add.status).toBe(201);
    expect(add.body).toEqual({
      publicId: p.publicId,
      nickname: 'Troll',
      avatarUrl: null,
      createdAt: expect.any(String),
    });
    // Додавання не виключає з поточних ігор.
    expect(await activeMembers(gameId)).toHaveLength(1);
    const second = await createGame(gm.cookie, {}, true);
    const r = await apply(second, p.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('GM_BLACKLISTED');
    expect((await apply(other.gameId, p.cookie)).status).toBe(201);
    expect(await eventsOf('gm.blacklisted')).toHaveLength(1);
  });

  it('list with profiles; delete unbans; self/unknown are rejected', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25, 'Troll');
    expect((await call('post', `/api/me/blacklist/${p.publicId}`, gm.cookie)).status).toBe(201);
    // Повторне додавання — ідемпотентне.
    expect((await call('post', `/api/me/blacklist/${p.publicId}`, gm.cookie)).status).toBe(201);
    const list = await call('get', '/api/me/blacklist', gm.cookie);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ publicId: p.publicId, nickname: 'Troll' });
    expect((await call('get', '/api/me/blacklist', p.cookie)).body).toEqual([]);
    expect((await call('post', `/api/me/blacklist/${gm.publicId}`, gm.cookie)).status).toBe(400);
    expect((await call('post', '/api/me/blacklist/nobody0000', gm.cookie)).status).toBe(404);
    expect((await call('delete', `/api/me/blacklist/${p.publicId}`, gm.cookie)).status).toBe(204);
    expect(await db.select().from(gmBlacklist)).toHaveLength(0);
    expect(await eventsOf('gm.unblacklisted')).toHaveLength(1);
    expect((await call('delete', `/api/me/blacklist/${p.publicId}`, gm.cookie)).status).toBe(404);
    expect((await call('get', '/api/me/blacklist')).status).toBe(401);
  });
});

describe('game rules with members', () => {
  it('maxPlayers below active members → 409 MAX_BELOW_MEMBERS; equal is fine', async () => {
    const { gm, gameId } = await setup({ minPlayers: 1, maxPlayers: 5 });
    const p1 = await userWithAge(25);
    const p2 = await userWithAge(25);
    await join(gm, gameId, p1);
    await join(gm, gameId, p2);
    const r = await call('patch', `/api/games/${gameId}`, gm.cookie, { maxPlayers: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MAX_BELOW_MEMBERS');
    expect((await call('patch', `/api/games/${gameId}`, gm.cookie, { maxPlayers: 2 })).status).toBe(
      200,
    );
    // Учасники, що вийшли, не рахуються.
    await call('post', `/api/games/${gameId}/leave`, p2.cookie, LEAVE);
    expect((await call('patch', `/api/games/${gameId}`, gm.cookie, { maxPlayers: 1 })).status).toBe(
      200,
    );
  });

  it('start with 1 member when min=3 → 200 with warning BELOW_MIN_PLAYERS', async () => {
    const { gm, gameId } = await setup({ minPlayers: 3, maxPlayers: 5 });
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const res = await call('post', `/api/games/${gameId}/start`, gm.cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('started');
    expect(res.body.warning).toBe('BELOW_MIN_PLAYERS');
  });

  it('start with enough members → no warning', async () => {
    const { gm, gameId } = await setup({ minPlayers: 1, maxPlayers: 5 });
    const p = await userWithAge(25);
    await join(gm, gameId, p);
    const res = await call('post', `/api/games/${gameId}/start`, gm.cookie);
    expect(res.status).toBe(200);
    expect('warning' in res.body).toBe(false);
  });

  it('finishing a game cancels its pending applications (game_finished, R3)', async () => {
    const { gm, gameId } = await setup({ showWhenFull: true });
    const p = await userWithAge(25);
    await call('post', `/api/games/${gameId}/start`, gm.cookie);
    const a = await apply(gameId, p.cookie);
    expect(a.status).toBe(201);
    expect((await call('post', `/api/games/${gameId}/finish`, gm.cookie)).status).toBe(200);
    const [row] = await db
      .select()
      .from(gameApplications)
      .where(eq(gameApplications.id, a.body.id));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'game_finished' });
    const ev = await eventsOf('application.cancelled_game');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: p.id, entityId: a.body.id });
  });
});
