import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { copyTitle } from '../../src/games/games.service.js';
import {
  gameApplications,
  gameMembers,
  gameSessions,
  games,
  users,
} from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { futureMondayKyiv, harness } from './fixtures.js';

const checked: string[] = [];
const deps = {
  ...(await testDeps()),
  imageUrlChecker: async (url: string) => {
    checked.push(url);
  },
};
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);

beforeEach(async () => {
  checked.length = 0;
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const COVER = 'https://img.example.com/cover.png';

describe('POST /api/games/:id/clone', () => {
  it('GM clones a published game → 201 draft copy with the description, rule and cover', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { coverUrl: COVER, priceUah: 150 }, true);
    checked.length = 0;
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(201);
    const copyId = res.body.id as number;
    expect(copyId).not.toBe(id);
    const [src] = await db.select().from(games).where(eq(games.id, id));
    const [copy] = await db.select().from(games).where(eq(games.id, copyId));
    expect(copy!.status).toBe('draft');
    expect(copy!.title).toBe('Прокляття Страда (копія)');
    expect(copy!.gmUserId).toBe(gm.id);
    for (const k of [
      'description',
      'systemId',
      'genreId',
      'format',
      'platform',
      'kind',
      'durationMinutes',
      'recurrence',
      'weekdays',
      'minPlayers',
      'maxPlayers',
      'priceUah',
      'ageRating',
      'coverUrl',
      'channelLinks',
      'address',
    ] as const) {
      expect(copy![k]).toEqual(src![k]);
    }
    expect(copy!.coverUrl).toBe(COVER);
    // Дата старту не копіюється: майстер задає її перед публікацією.
    expect(copy!.startsAt).toBeNull();
    expect(copy!.publishedAt).toBeNull();
    expect(copy!.deadAt).toBeNull();
    expect(copy!.pausedAt).toBeNull();
    // Обкладинка не перевіряється повторно.
    expect(checked).toEqual([]);
    // Без дати копію не опублікувати; з датою — можна.
    const noDate = await call('post', `/api/games/${copyId}/publish`, gm.cookie);
    expect(noDate.status).toBe(422);
    expect(noDate.body.error.code).toBe('GAME_START_REQUIRED');
    const startsAt = futureMondayKyiv();
    expect((await call('patch', `/api/games/${copyId}`, gm.cookie, { startsAt })).status).toBe(200);
    expect((await call('post', `/api/games/${copyId}/publish`, gm.cookie)).status).toBe(200);
  });

  it('copies content warnings but no members, applications or sessions', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { contentWarningIds: [1] }, true);
    const copyId = (await call('post', `/api/games/${id}/clone`, gm.cookie)).body.id as number;
    expect(await db.select().from(gameMembers).where(eq(gameMembers.gameId, copyId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(gameApplications).where(eq(gameApplications.gameId, copyId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(gameSessions).where(eq(gameSessions.gameId, copyId)),
    ).toHaveLength(0);
    const view = await call('get', `/api/games/${copyId}`, gm.cookie);
    expect(view.body.contentWarningIds).toEqual([1]);
  });

  it('a paused campaign clones into a normal draft without pause fields', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${id}/start`, gm.cookie);
    const p = await call('post', `/api/games/${id}/pause`, gm.cookie, { reason: 'vacation' });
    expect(p.status).toBe(200);
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(201);
    const [copy] = await db.select().from(games).where(eq(games.id, res.body.id));
    expect(copy!.status).toBe('draft');
    expect(copy!.pausedAt).toBeNull();
    expect(copy!.pauseReason).toBeNull();
    expect(copy!.pauseNote).toBeNull();
  });

  it('a long title is truncated to the maximum length with the suffix', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { title: 'А'.repeat(120) });
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(201);
    const [copy] = await db.select().from(games).where(eq(games.id, res.body.id));
    expect(copy!.title).toHaveLength(120);
    expect(copy!.title.endsWith(' (копія)')).toBe(true);
  });

  it('non-GM → 403 (own draft of another → 404); guest → 401; unknown → 404', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const pub = await createGame(gm.cookie, {}, true);
    const draft = await createGame(gm.cookie);
    expect((await call('post', `/api/games/${pub}/clone`, other.cookie)).status).toBe(403);
    expect((await call('post', `/api/games/${draft}/clone`, other.cookie)).status).toBe(404);
    expect((await call('post', `/api/games/${pub}/clone`)).status).toBe(401);
    expect((await call('post', `/api/games/999999/clone`, gm.cookie)).status).toBe(404);
    expect(await db.select().from(games)).toHaveLength(2);
  });

  it('finished and cancelled games can be cloned; the source is unchanged', async () => {
    const gm = await userWithAge(30);
    const a = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${a}/cancel`, gm.cookie);
    const b = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${b}/start`, gm.cookie);
    await call('post', `/api/games/${b}/finish`, gm.cookie);
    for (const id of [a, b]) {
      const [before] = await db.select().from(games).where(eq(games.id, id));
      const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
      expect(res.status).toBe(201);
      const [copy] = await db.select().from(games).where(eq(games.id, res.body.id));
      expect(copy!.status).toBe('draft');
      expect(copy!.finishedAt).toBeNull();
      expect(copy!.cancelledAt).toBeNull();
      const [after] = await db.select().from(games).where(eq(games.id, id));
      expect(after).toEqual(before);
    }
  });

  it('a game closed by the administration cannot be cloned (403), nothing created', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${id}/cancel`, gm.cookie);
    await db.update(games).set({ closedByAdmin: true }).where(eq(games.id, id));
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await db.select().from(games)).toHaveLength(1);
  });

  it('the copy keeps the source timezone even if the GM changed theirs', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {});
    await db.update(users).set({ timezone: 'Pacific/Auckland' }).where(eq(users.id, gm.id));
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(201);
    const [copy] = await db.select().from(games).where(eq(games.id, res.body.id));
    expect(copy!.timezone).toBe('Europe/Kyiv');
    expect(copy!.weekdays).toEqual([0]);
    expect(copy!.startsAt).toBeNull();
  });

  it('title cut counts code points (no lone surrogate)', () => {
    const t = copyTitle('😀'.repeat(119) + 'ab');
    expect(t.endsWith(' (копія)')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(120);
    expect(
      Array.from(t).every(
        (c) => c.length === 2 || c.charCodeAt(0) < 0xd800 || c.charCodeAt(0) > 0xdfff,
      ),
    ).toBe(true);
  });

  it('creation limits apply: a dead game blocks the clone', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, {}, true);
    await db.update(games).set({ deadAt: new Date() }).where(eq(games.id, id));
    const res = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAME_CREATION_BLOCKED');
  });
});
