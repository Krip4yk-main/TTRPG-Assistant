import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { toZoned, zonedToUtc } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { entityViews, gameSessions } from '../../src/db/schema/index.js';
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

type User = Awaited<ReturnType<typeof userWithAge>>;

/** Щотижнева кампанія з першою сесією за 2 дні (19:00 Київ) — сесії одразу у вікні. */
function soon() {
  const TZ = 'Europe/Kyiv';
  const z = toZoned(new Date(Date.now() + 2 * 86_400_000), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour: 19, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekdays: [z.weekday] };
}

const APPLY = { warningsAccepted: true, answers: [] as string[] };

async function apply(gameId: number, p: User, body: object = APPLY): Promise<number> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, body);
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  return a.body.id as number;
}

async function join(gm: User, gameId: number, p: User): Promise<number> {
  const id = await apply(gameId, p);
  const ok = await call('post', `/api/applications/${id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status}`);
  return id;
}

const seenOfGame = async (gameId: number, u: User) =>
  (await call('get', `/api/games/${gameId}`, u.cookie)).body.seen as string | undefined;

const gmApps = async (gameId: number, gm: User) =>
  (await call('get', `/api/games/${gameId}/applications`, gm.cookie)).body as {
    id: number;
    seen: string;
  }[];

const myApps = async (u: User) =>
  (await call('get', '/api/me/applications', u.cookie)).body as { id: number; seen: string }[];

const sessionsOf = async (gameId: number, u: User) =>
  (await call('get', `/api/games/${gameId}/sessions`, u.cookie)).body as {
    id: number;
    seen: string;
  }[];

const views = (u: User, entityType: string, ids: number[]) =>
  call('post', '/api/me/views', u.cookie, { entityType, ids });

async function viewRows(userId: number) {
  return db.select().from(entityViews).where(eq(entityViews.userId, userId));
}

describe('seen: game details', () => {
  it('new → seen after GET details; updated after GM change; seen again after reopening', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const gameId = await createGame(gm.cookie, {}, true);
    expect(await seenOfGame(gameId, p)).toBe('new');
    expect(await seenOfGame(gameId, p)).toBe('seen');
    expect((await call('patch', `/api/games/${gameId}`, gm.cookie, { title: 'Нова' })).status).toBe(
      200,
    );
    expect(await seenOfGame(gameId, p)).toBe('updated');
    expect(await seenOfGame(gameId, p)).toBe('seen');
  });

  it("the actor's own changes do not flip their own seen to updated", async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    // Створення й публікація — власні дії: гра не «нова» для майстра.
    expect(await seenOfGame(gameId, gm)).toBe('seen');
    await call('patch', `/api/games/${gameId}`, gm.cookie, { title: 'Ще назва' });
    expect(await seenOfGame(gameId, gm)).toBe('seen');
    const mine = (await call('get', '/api/games/mine', gm.cookie)).body as { seen: string }[];
    expect(mine.map((g) => g.seen)).toEqual(['seen']);
  });

  it('guests and restricted views get no seen and record nothing', async () => {
    const gm = await userWithAge(30);
    const young = await userWithAge(16);
    const gameId = await createGame(gm.cookie, { ageRating: '18+' }, true);
    const guest = await call('get', `/api/games/${gameId}`);
    expect(guest.body.seen).toBeUndefined();
    const r = await call('get', `/api/games/${gameId}`, young.cookie);
    expect(r.body.restricted).toBe(true);
    expect(r.body.seen).toBeUndefined();
    expect(await viewRows(young.id)).toHaveLength(0);
  });

  it('my games shows updated when someone else (system) changed the game', async () => {
    const gm = await userWithAge(30);
    const gameId = await createGame(gm.cookie, {}, true);
    const { games } = await import('../../src/db/schema/index.js');
    await db
      .update(games)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(games.id, gameId));
    const mine = (await call('get', '/api/games/mine', gm.cookie)).body as { seen: string }[];
    expect(mine[0]!.seen).toBe('updated');
  });
});

describe('seen: applications', () => {
  it('GM list: new → seen via POST /api/me/views → updated after applicant withdraws', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const gameId = await createGame(gm.cookie, {}, true);
    const appId = await apply(gameId, p);
    expect((await gmApps(gameId, gm)).map((a) => a.seen)).toEqual(['new']);
    // Перегляд списку сам не позначає (інакше «нове» зникло б до показу).
    expect((await gmApps(gameId, gm)).map((a) => a.seen)).toEqual(['new']);
    expect((await views(gm, 'application', [appId])).status).toBe(204);
    expect((await gmApps(gameId, gm)).map((a) => a.seen)).toEqual(['seen']);
    expect((await call('delete', `/api/applications/${appId}`, p.cookie)).status).toBe(200);
    expect((await gmApps(gameId, gm)).map((a) => a.seen)).toEqual(['updated']);
    // Автор: власні подача й відкликання — не «оновлення».
    expect((await myApps(p)).map((a) => a.seen)).toEqual(['seen']);
  });

  it("applicant sees updated after GM decision or constraint answer; GM's own stays seen", async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const gameId = await createGame(gm.cookie, {}, true);
    const appId = await apply(gameId, p, { ...APPLY, constraints: ['Лише вечорами'] });
    expect((await myApps(p))[0]!.seen).toBe('seen');
    const [dto] = await gmApps(gameId, gm);
    const cid = (dto as unknown as { constraints: { id: string }[] }).constraints[0]!.id;
    await views(gm, 'application', [appId]);
    const put = await call('put', `/api/applications/${appId}/constraints/${cid}`, gm.cookie, {
      response: 'accepted',
    });
    expect(put.status).toBe(200);
    expect((await myApps(p))[0]!.seen).toBe('updated');
    expect((await gmApps(gameId, gm))[0]!.seen).toBe('seen');
    await views(p, 'application', [appId]);
    expect((await myApps(p))[0]!.seen).toBe('seen');
    expect((await call('post', `/api/applications/${appId}/reject`, gm.cookie)).status).toBe(200);
    expect((await myApps(p))[0]!.seen).toBe('updated');
    expect((await gmApps(gameId, gm))[0]!.seen).toBe('seen');
  });
});

describe('seen: sessions', () => {
  it('member: new → seen via views → updated after reschedule; GM stays seen; RSVP flips nothing', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const q = await userWithAge(26);
    const gameId = await createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    await join(gm, gameId, q);
    const list = await sessionsOf(gameId, p);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list.map((s) => s.seen))).toEqual(new Set(['new']));
    const first = list[0]!.id;
    expect(
      (
        await views(
          p,
          'session',
          list.map((s) => s.id),
        )
      ).status,
    ).toBe(204);
    expect((await sessionsOf(gameId, p))[0]!.seen).toBe('seen');
    // RSVP іншого учасника — не зміна сесії.
    expect(
      (await call('put', `/api/sessions/${first}/rsvp`, q.cookie, { status: 'going' })).status,
    ).toBe(200);
    expect((await sessionsOf(gameId, p))[0]!.seen).toBe('seen');
    const [row] = await db.select().from(gameSessions).where(eq(gameSessions.id, first));
    const to = new Date(row!.startsAt.getTime() + 3_600_000).toISOString();
    const r = await call('post', `/api/sessions/${first}/reschedule`, gm.cookie, { startsAt: to });
    expect(r.status).toBe(200);
    expect(r.body.seen).toBe('seen');
    const after = await sessionsOf(gameId, p);
    expect(after.find((s) => s.id === first)!.seen).toBe('updated');
    expect(after.filter((s) => s.id !== first).every((s) => s.seen === 'seen')).toBe(true);
    expect((await sessionsOf(gameId, gm)).find((s) => s.id === first)!.seen).toBe('seen');
  });
});

describe('POST /api/me/views', () => {
  it('silently ignores entities the user cannot see (no rows, same 204)', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const stranger = await userWithAge(27);
    const draft = await createGame(gm.cookie);
    const gameId = await createGame(gm.cookie, soon(), true);
    const appId = await join(gm, gameId, p);
    const [s] = await db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId));
    const cases: [string, number[]][] = [
      ['game', [draft, 999_999]],
      ['application', [appId, 999_999]],
      ['session', [s!.id, 999_999]],
    ];
    for (const [type, ids] of cases) {
      const r = await views(stranger, type, ids);
      expect(r.status).toBe(204);
      expect(r.text).toBe('');
    }
    expect(await viewRows(stranger.id)).toHaveLength(0);
    // Видиме — позначається.
    expect((await views(stranger, 'game', [gameId, draft])).status).toBe(204);
    const rows = await viewRows(stranger.id);
    expect(rows.map((r) => [r.entityType, r.entityId])).toEqual([['game', gameId]]);
  });

  it('former member can no longer mark sessions; member and GM can', async () => {
    const gm = await userWithAge(30);
    const p = await userWithAge(25);
    const gameId = await createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const [s] = await db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId));
    await call('post', `/api/games/${gameId}/leave`, p.cookie, {
      noteForGm: 'Не встигаю, вибачте',
    });
    await views(p, 'session', [s!.id]);
    const own = await db
      .select()
      .from(entityViews)
      .where(and(eq(entityViews.userId, p.id), eq(entityViews.entityType, 'session')));
    expect(own).toHaveLength(0);
  });

  it('validates input', async () => {
    const u = await userWithAge(25);
    expect((await views(u, 'user', [1])).status).toBe(400);
    expect((await views(u, 'game', [])).status).toBe(400);
    expect((await views(u, 'game', [0])).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => i + 1);
    expect((await views(u, 'game', many)).status).toBe(400);
    expect(
      (await call('post', '/api/me/views', undefined, { entityType: 'game', ids: [1] })).status,
    ).toBe(401);
  });
});
