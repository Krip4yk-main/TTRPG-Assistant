import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { gameApplications, gameMembers, gameSessions, games } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

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
    // Той самий день тижня й час, але не в минулому (дата старту — не з оригіналу).
    expect(copy!.startsAt.getTime()).toBeGreaterThan(Date.now());
    expect((copy!.startsAt.getTime() - src!.startsAt.getTime()) % (7 * 86_400_000)).toBe(
      (copy!.startsAt.getUTCHours() - src!.startsAt.getUTCHours()) * 3_600_000,
    );
    expect(copy!.publishedAt).toBeNull();
    expect(copy!.deadAt).toBeNull();
    expect(copy!.pausedAt).toBeNull();
    // Обкладинка не перевіряється повторно.
    expect(checked).toEqual([]);
    // Копію можна опублікувати без змін.
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

  it('finished and cancelled games cannot be cloned (409)', async () => {
    const gm = await userWithAge(30);
    const a = await createGame(gm.cookie, {}, true);
    await call('post', `/api/games/${a}/cancel`, gm.cookie);
    const res = await call('post', `/api/games/${a}/clone`, gm.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAME_INVALID_TRANSITION');
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
