import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { games } from '../../src/db/schema/index.js';
import { ImageUrlError } from '../../src/http/image-url.js';
import type { ImageUrlInvalidReason } from '@nri/shared';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from './fixtures.js';

/** Фейкова перевірка: мережі в тестах немає; `bad-<reason>` у шляху → відповідна помилка. */
const checked: string[] = [];
const deps = {
  ...(await testDeps()),
  imageUrlChecker: async (url: string) => {
    checked.push(url);
    const m = /bad-(\w+)/.exec(url);
    if (m) throw new ImageUrlError(m[1] as ImageUrlInvalidReason);
  },
};
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, validGame, call, createGame } = harness(deps, app);

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

describe('cover URL verification on save', () => {
  it('create with a valid cover → 201, checked once; null cover → not checked', async () => {
    const gm = await userWithAge(30);
    const res = await call('post', '/api/games', gm.cookie, await validGame({ coverUrl: COVER }));
    expect(res.status).toBe(201);
    expect(res.body.coverUrl).toBe(COVER);
    expect(checked).toEqual([COVER]);
    await createGame(gm.cookie, { coverUrl: null });
    expect(checked).toEqual([COVER]);
  });

  it.each(['not_image', 'too_large', 'forbidden_address', 'timeout', 'unreachable'])(
    'create with a %s cover → 422 IMAGE_URL_INVALID, nothing saved',
    async (reason) => {
      const gm = await userWithAge(30);
      const res = await call(
        'post',
        '/api/games',
        gm.cookie,
        await validGame({ coverUrl: `https://img.example.com/bad-${reason}.png` }),
      );
      expect(res.status).toBe(422);
      expect(res.body.error).toEqual({
        code: 'IMAGE_URL_INVALID',
        details: { field: 'coverUrl', reason },
      });
      expect(await db.select().from(games)).toHaveLength(0);
    },
  );

  it('PATCH: unchanged cover is not re-checked; a new one is; null clears without a check', async () => {
    const gm = await userWithAge(30);
    const id = await createGame(gm.cookie, { coverUrl: COVER });
    checked.length = 0;
    const same = await call('patch', `/api/games/${id}`, gm.cookie, {
      coverUrl: COVER,
      title: 'Нова назва',
    });
    expect(same.status).toBe(200);
    expect(checked).toEqual([]);

    const next = 'https://img.example.com/other.webp';
    expect((await call('patch', `/api/games/${id}`, gm.cookie, { coverUrl: next })).status).toBe(
      200,
    );
    expect(checked).toEqual([next]);

    const bad = await call('patch', `/api/games/${id}`, gm.cookie, {
      coverUrl: 'https://img.example.com/bad-not_image',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toEqual({ field: 'coverUrl', reason: 'not_image' });
    const [row] = await db.select().from(games).where(eq(games.id, id));
    expect(row!.coverUrl).toBe(next);

    const cleared = await call('patch', `/api/games/${id}`, gm.cookie, { coverUrl: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.coverUrl).toBeNull();
    expect(checked).toEqual([next, 'https://img.example.com/bad-not_image']);
  });

  it('real checker: a loopback / private IP literal → 422 forbidden_address without network', async () => {
    const real = { ...deps, imageUrlChecker: undefined };
    const realApp = createApp(real);
    const h = harness(real, realApp);
    const gm = await h.userWithAge(30);
    for (const coverUrl of ['https://127.0.0.1/a.png', 'https://10.0.0.1/a.png']) {
      const res = await h.call('post', '/api/games', gm.cookie, await h.validGame({ coverUrl }));
      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual({ field: 'coverUrl', reason: 'forbidden_address' });
    }
  });

  it('at most 20 cover checks per hour per user → 429 RATE_LIMITED', async () => {
    const gm = await userWithAge(30);
    const other = await userWithAge(30);
    const id = await createGame(gm.cookie);
    for (let i = 0; i < 20; i++) {
      const res = await call('patch', `/api/games/${id}`, gm.cookie, {
        coverUrl: `https://img.example.com/${i}.png`,
      });
      expect(res.status).toBe(200);
    }
    const limited = await call('patch', `/api/games/${id}`, gm.cookie, {
      coverUrl: 'https://img.example.com/21.png',
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // Збереження без обкладинки не обмежується; інший користувач — окремий лічильник.
    expect(
      (await call('patch', `/api/games/${id}`, gm.cookie, { title: 'Без обкладинки' })).status,
    ).toBe(200);
    const res = await call(
      'post',
      '/api/games',
      other.cookie,
      await validGame({ coverUrl: COVER }),
    );
    expect(res.status).toBe(201);
  });
});
