import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { contentWarnings, games, gameSafetyTopics } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, validGame, call, createGame } = harness(deps, app);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

async function warningIds(n: number): Promise<number[]> {
  const ws = await db
    .select({ id: contentWarnings.id })
    .from(contentWarnings)
    .orderBy(asc(contentWarnings.id))
    .limit(n);
  return ws.map((w) => w.id);
}

const EMPTY = { warningIds: [], custom: [] };

describe('game safety — create and read', () => {
  it('a game without safety fields gets empty defaults', async () => {
    const gm = await userWithAge(30);
    const res = await call('post', '/api/games', gm.cookie, await validGame());
    expect(res.status).toBe(201);
    expect(res.body.safetyTools).toEqual([]);
    expect(res.body.lines).toEqual(EMPTY);
    expect(res.body.veils).toEqual(EMPTY);
  });

  it('stores tools, lines and veils normalized (unique, trimmed, tools in canonical order)', async () => {
    const gm = await userWithAge(30);
    const [w1, w2, w3] = await warningIds(3);
    const res = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({
        safetyTools: ['script_change', 'x_card', 'x_card'],
        lines: { warningIds: [w2, w1, w2], custom: ['  Павуки ', 'павуки', 'Голод'] },
        veils: { warningIds: [w3], custom: ['Тортури'] },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.safetyTools).toEqual(['x_card', 'script_change']);
    expect(res.body.lines).toEqual({ warningIds: [w1, w2], custom: ['Павуки', 'Голод'] });
    expect(res.body.veils).toEqual({ warningIds: [w3], custom: ['Тортури'] });
    const topics = await db
      .select({ warningId: gameSafetyTopics.warningId, kind: gameSafetyTopics.kind })
      .from(gameSafetyTopics)
      .where(eq(gameSafetyTopics.gameId, res.body.id as number))
      .orderBy(asc(gameSafetyTopics.warningId));
    expect(topics).toEqual([
      { warningId: w1, kind: 'line' },
      { warningId: w2, kind: 'line' },
      { warningId: w3, kind: 'veil' },
    ]);
  });

  it('safety fields are public: a stranger and a guest see them', async () => {
    const gm = await userWithAge(30);
    const [w1] = await warningIds(1);
    const id = await createGame(
      gm.cookie,
      {
        safetyTools: ['open_door'],
        lines: { warningIds: [w1], custom: [] },
        veils: { warningIds: [], custom: ['Смерть тварин'] },
      },
      true,
    );
    const stranger = await userWithAge(25);
    for (const cookie of [stranger.cookie, undefined]) {
      const view = await call('get', `/api/games/${id}`, cookie);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({
        safetyTools: ['open_door'],
        lines: { warningIds: [w1], custom: [] },
        veils: { warningIds: [], custom: ['Смерть тварин'] },
      });
      // Приватні поля гри — як і раніше, приховані.
      expect(view.body.address).toBeUndefined();
    }
  });

  it('an age-restricted view does not leak safety fields', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { ageRating: '18+', safetyTools: ['x_card'] }, true);
    const view = await call('get', `/api/games/${id}`);
    expect(view.body.restricted).toBe(true);
    expect(view.body.safetyTools).toBeUndefined();
  });
});

describe('game safety — validation', () => {
  it.each([
    ['unknown tool', { safetyTools: ['panic_button'] }],
    ['too many custom lines', { lines: { custom: Array.from({ length: 11 }, (_, i) => `т${i}`) } }],
    ['custom line too long', { lines: { custom: ['я'.repeat(101)] } }],
    ['empty custom veil', { veils: { custom: ['   '] } }],
    ['extra key in a list', { lines: { warningIds: [], custom: [], extra: 1 } }],
    [
      'custom text both line and veil',
      { lines: { custom: ['Павуки'] }, veils: { custom: ['павуки'] } },
    ],
  ])('%s → 400 VALIDATION', async (_name, patch) => {
    const gm = await userWithAge(30);
    const res = await call('post', '/api/games', gm.cookie, await validGame(patch));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('a catalog topic cannot be both a line and a veil', async () => {
    const gm = await userWithAge(30);
    const [w1] = await warningIds(1);
    const res = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({ lines: { warningIds: [w1] }, veils: { warningIds: [w1] } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['veils'] })]),
    );
  });

  it('unknown catalog ids in lines or veils → 400 UNKNOWN_WARNING', async () => {
    const gm = await userWithAge(30);
    for (const patch of [{ lines: { warningIds: [99999] } }, { veils: { warningIds: [99999] } }]) {
      const res = await call('post', '/api/games', gm.cookie, await validGame(patch));
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'VALIDATION',
        details: { reason: 'UNKNOWN_WARNING' },
      });
    }
  });

  it('exactly 10 custom lines of 100 characters are accepted', async () => {
    const gm = await userWithAge(30);
    const custom = Array.from({ length: 10 }, (_, i) => `${i}${'я'.repeat(99)}`);
    const res = await call('post', '/api/games', gm.cookie, await validGame({ lines: { custom } }));
    expect(res.status).toBe(201);
    expect(res.body.lines.custom).toEqual(custom);
  });
});

describe('game safety — edit and clone', () => {
  it('PATCH replaces lines/veils; other safety fields and content warnings stay', async () => {
    const gm = await userWithAge(30);
    const [w1, w2, w3] = await warningIds(3);
    const id = await createGame(
      gm.cookie,
      {
        contentWarningIds: [w3],
        safetyTools: ['session_zero'],
        lines: { warningIds: [w1], custom: ['Павуки'] },
      },
      true,
    );
    // Перенести тему з меж у завіси одним патчем — можна.
    const moved = await call('patch', `/api/games/${id}`, gm.cookie, {
      lines: { warningIds: [w2], custom: [] },
      veils: { warningIds: [w1], custom: ['Павуки'] },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.lines).toEqual({ warningIds: [w2], custom: [] });
    expect(moved.body.veils).toEqual({ warningIds: [w1], custom: ['Павуки'] });
    expect(moved.body.safetyTools).toEqual(['session_zero']);
    expect(moved.body.contentWarningIds).toEqual([w3]);

    // Патч лише завіс, що перетинається з наявними межами, — 400, нічого не змінено.
    const clash = await call('patch', `/api/games/${id}`, gm.cookie, {
      veils: { warningIds: [w2], custom: [] },
    });
    expect(clash.status).toBe(400);

    // Патч інших полів не чіпає безпеку; зміна попереджень — теж.
    const other = await call('patch', `/api/games/${id}`, gm.cookie, {
      title: 'Нова назва',
      contentWarningIds: [],
    });
    expect(other.status).toBe(200);
    expect(other.body.lines).toEqual({ warningIds: [w2], custom: [] });
    expect(other.body.veils).toEqual({ warningIds: [w1], custom: ['Павуки'] });
    expect(other.body.contentWarningIds).toEqual([]);

    // Очищення.
    const cleared = await call('patch', `/api/games/${id}`, gm.cookie, {
      safetyTools: [],
      lines: EMPTY,
      veils: EMPTY,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ safetyTools: [], lines: EMPTY, veils: EMPTY });
    expect(
      await db.select().from(gameSafetyTopics).where(eq(gameSafetyTopics.gameId, id)),
    ).toHaveLength(0);
    const [row] = await db.select().from(games).where(eq(games.id, id));
    expect(row).toMatchObject({ safetyTools: [], linesCustom: [], veilsCustom: [] });
  });

  it('clone copies safety tools, lines and veils', async () => {
    const gm = await userWithAge(30);
    const [w1, w2] = await warningIds(2);
    const safety = {
      safetyTools: ['x_card', 'check_ins'],
      lines: { warningIds: [w1], custom: ['Павуки'] },
      veils: { warningIds: [w2], custom: ['Тортури'] },
    };
    const id = await createGame(gm.cookie, safety, true);
    const copy = await call('post', `/api/games/${id}/clone`, gm.cookie);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject(safety);
    const view = await call('get', `/api/games/${copy.body.id as number}`, gm.cookie);
    expect(view.body).toMatchObject(safety);
  });
});
