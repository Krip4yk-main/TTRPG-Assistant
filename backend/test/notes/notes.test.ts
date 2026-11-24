import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { calendarPinnedGames, gameSessions } from '../../src/db/schema/index.js';
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

const LEAVE = { noteForGm: 'Не встигаю за розкладом' };

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, {
    warningsAccepted: true,
    answers: [],
  });
  if (a.status !== 201) throw new Error(`apply ${a.status}`);
  const ok = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status}`);
}

async function setup() {
  const gm = await userWithAge(30, 'Майстер');
  const gameId = await createGame(gm.cookie, {}, true);
  const p1 = await userWithAge(25, 'Alpha');
  const p2 = await userWithAge(25, 'Beta');
  await join(gm, gameId, p1);
  await join(gm, gameId, p2);
  return { gm, gameId, p1, p2 };
}

const put = (path: string, cookie: string, body: string, version: number) =>
  call('put', path, cookie, { body, version });

type Page = { author: { publicId: string; nickname: string } };

describe('shared notes', () => {
  it('GM gets 403 on shared notes; players see all pages, edit only their own', async () => {
    const { gm, gameId, p1, p2 } = await setup();
    const path = `/api/games/${gameId}/notes/shared`;
    expect((await call('get', path, gm.cookie)).status).toBe(403);
    expect((await put(path, gm.cookie, 'x', 0)).status).toBe(403);

    const w = await put(path, p1.cookie, 'Підозрюю дворецького', 0);
    expect(w.status).toBe(200);
    expect(w.body).toEqual({
      body: 'Підозрюю дворецького',
      version: 1,
      updatedAt: expect.any(String),
    });

    const r = await call('get', path, p2.cookie);
    expect(r.status).toBe(200);
    expect(r.body.pages).toEqual([
      {
        author: { publicId: p1.publicId, nickname: 'Alpha', avatarUrl: null },
        formerMember: false,
        body: 'Підозрюю дворецького',
        version: 1,
        updatedAt: expect.any(String),
      },
      {
        author: { publicId: p2.publicId, nickname: 'Beta', avatarUrl: null },
        formerMember: false,
        body: '',
        version: 0,
        updatedAt: null,
      },
    ]);
    // PUT пише лише у власну сторінку.
    expect((await put(path, p2.cookie, 'моє', 0)).status).toBe(200);
    const again = await call('get', path, p1.cookie);
    expect(again.body.pages[0].body).toBe('Підозрюю дворецького');
    expect(again.body.pages[1].body).toBe('моє');
  });

  it('strangers 403; unauthenticated 401; hidden draft and unknown game 404', async () => {
    const { gameId } = await setup();
    const stranger = await userWithAge(25);
    const path = `/api/games/${gameId}/notes/shared`;
    expect((await call('get', path, stranger.cookie)).status).toBe(403);
    expect((await call('get', path)).status).toBe(401);
    const gm2 = await userWithAge(30);
    const draft = await createGame(gm2.cookie, {}, false);
    const d = await call('get', `/api/games/${draft}/notes/shared`, stranger.cookie);
    expect(d.status).toBe(404);
    const u = await call('get', '/api/games/999999/notes/shared', stranger.cookie);
    expect(u.status).toBe(404);
  });

  it('former member: 403 for them, page stays visible with formerMember flag', async () => {
    const { gm, gameId, p1, p2 } = await setup();
    const path = `/api/games/${gameId}/notes/shared`;
    await put(path, p1.cookie, 'залишок', 0);
    await call('post', `/api/games/${gameId}/leave`, p1.cookie, LEAVE);
    expect((await call('get', path, p1.cookie)).status).toBe(403);
    expect((await put(path, p1.cookie, 'x', 1)).status).toBe(403);
    const r = await call('get', path, p2.cookie);
    expect(r.status).toBe(200);
    const former = r.body.pages.find((p: Page) => p.author.publicId === p1.publicId);
    expect(former).toMatchObject({ formerMember: true, body: 'залишок', version: 1 });
    const own = r.body.pages.find((p: Page) => p.author.publicId === p2.publicId);
    expect(own.formerMember).toBe(false);
    // Колишній без нотатки на сторінках не показується.
    const p3 = await userWithAge(25, 'Gamma');
    await join(gm, gameId, p3);
    await call('post', `/api/games/${gameId}/members/${p3.publicId}/kick`, gm.cookie);
    const r2 = await call('get', path, p2.cookie);
    expect(r2.body.pages.map((p: Page) => p.author.nickname)).toEqual(['Beta', 'Alpha']);
  });
});

describe('private notes', () => {
  it('each participant incl. GM has their own game note, invisible to others', async () => {
    const { gm, gameId, p1, p2 } = await setup();
    const path = `/api/games/${gameId}/notes/private`;
    expect((await call('get', path, gm.cookie)).body).toEqual({
      body: '',
      version: 0,
      updatedAt: null,
    });
    expect((await put(path, gm.cookie, 'секрет майстра', 0)).status).toBe(200);
    expect((await put(path, p1.cookie, 'секрет гравця', 0)).status).toBe(200);
    expect((await call('get', path, gm.cookie)).body.body).toBe('секрет майстра');
    expect((await call('get', path, p1.cookie)).body.body).toBe('секрет гравця');
    expect((await call('get', path, p2.cookie)).body.version).toBe(0);
    const shared = await call('get', `/api/games/${gameId}/notes/shared`, p2.cookie);
    expect(JSON.stringify(shared.body)).not.toContain('секрет');
  });

  it('former member and stranger lose access', async () => {
    const { gameId, p1 } = await setup();
    const stranger = await userWithAge(25);
    const path = `/api/games/${gameId}/notes/private`;
    await put(path, p1.cookie, 'a', 0);
    await call('post', `/api/games/${gameId}/leave`, p1.cookie, LEAVE);
    expect((await call('get', path, p1.cookie)).status).toBe(403);
    expect((await put(path, stranger.cookie, 'a', 0)).status).toBe(403);
  });

  it('session notes are per session and participant; access follows the game', async () => {
    const { gm, gameId, p1, p2 } = await setup();
    // Сесії матеріалізуються у вікні найближчих тижнів: беремо їх прямо з БД.
    await db.insert(gameSessions).values(
      [3, 10].map((d) => ({
        gameId,
        startsAt: new Date(Date.now() + d * 86_400_000),
        durationMinutes: 120,
        origin: 'manual' as const,
      })),
    );
    const list = await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const [s1, s2] = list.body as { id: number }[];
    const a = `/api/sessions/${s1!.id}/notes/private`;
    const b = `/api/sessions/${s2!.id}/notes/private`;
    expect((await put(a, gm.cookie, 'GM s1', 0)).status).toBe(200);
    expect((await put(a, p1.cookie, 'P1 s1', 0)).status).toBe(200);
    expect((await put(b, p1.cookie, 'P1 s2', 0)).status).toBe(200);
    expect((await call('get', a, p1.cookie)).body.body).toBe('P1 s1');
    expect((await call('get', b, p1.cookie)).body.body).toBe('P1 s2');
    expect((await call('get', a, gm.cookie)).body.body).toBe('GM s1');
    expect((await call('get', a, p2.cookie)).body.version).toBe(0);
    const stranger = await userWithAge(25);
    expect((await call('get', a, stranger.cookie)).status).toBe(403);
    expect((await call('get', '/api/sessions/999999/notes/private', gm.cookie)).status).toBe(404);
    await call('post', `/api/games/${gameId}/leave`, p1.cookie, LEAVE);
    expect((await call('get', a, p1.cookie)).status).toBe(403);
  });
});

describe('optimistic locking', () => {
  it('stale version → 409 NOTE_CONFLICT with current body/version', async () => {
    const { gameId, p1 } = await setup();
    const path = `/api/games/${gameId}/notes/private`;
    expect((await put(path, p1.cookie, 'v1', 0)).body.version).toBe(1);
    expect((await put(path, p1.cookie, 'v2', 1)).body.version).toBe(2);
    const stale = await put(path, p1.cookie, 'старе', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: 'NOTE_CONFLICT',
      details: { body: 'v2', version: 2 },
    });
    const stale0 = await put(path, p1.cookie, 'ще раз з нуля', 0);
    expect(stale0.status).toBe(409);
    expect(stale0.body.error.details).toEqual({ body: 'v2', version: 2 });
    expect((await put(path, p1.cookie, 'x', 9)).status).toBe(409);
  });

  it('two concurrent PUTs with the same version: exactly one 200', async () => {
    const { gameId, p1 } = await setup();
    const path = `/api/games/${gameId}/notes/private`;
    for (let round = 0; round < 2; round++) {
      const cur = (await call('get', path, p1.cookie)).body.version as number;
      const [r1, r2] = await Promise.all([
        put(path, p1.cookie, 'A', cur),
        put(path, p1.cookie, 'B', cur),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2;
      const winner = r1.status === 200 ? r1 : r2;
      expect(loser.body.error.details).toEqual({ body: winner.body.body, version: cur + 1 });
    }
  });
});

describe('body limits', () => {
  it('accepts 200 000 Cyrillic chars, rejects 200 001 with 400 VALIDATION', async () => {
    const { gameId, p1 } = await setup();
    const path = `/api/games/${gameId}/notes/private`;
    const ok = await put(path, p1.cookie, 'ї'.repeat(200_000), 0);
    expect(ok.status).toBe(200);
    const back = await call('get', path, p1.cookie);
    expect(back.body.body.length).toBe(200_000);
    const over = await put(path, p1.cookie, 'ї'.repeat(200_001), 1);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('VALIDATION');
  });

  it('other routes still reject bodies over 100 KB', async () => {
    const res = await call('post', '/api/health-echo', undefined, { x: 'a'.repeat(150_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});

describe('calendar pins are cleared when membership ends', () => {
  const pin = (gameId: number, cookie: string) =>
    call('post', `/api/me/calendar/pinned-games/${gameId}`, cookie);
  const pins = (userId: number, gameId: number) =>
    db
      .select()
      .from(calendarPinnedGames)
      .where(and(eq(calendarPinnedGames.userId, userId), eq(calendarPinnedGames.gameId, gameId)));

  it('leave, kick, ban', async () => {
    const { gm, gameId, p1, p2 } = await setup();
    const p3 = await userWithAge(25, 'Gamma');
    await join(gm, gameId, p3);
    for (const p of [p1, p2, p3]) {
      expect((await pin(gameId, p.cookie)).status).toBeLessThan(300);
      expect(await pins(p.id, gameId)).toHaveLength(1);
    }
    await call('post', `/api/games/${gameId}/leave`, p1.cookie, LEAVE);
    await call('post', `/api/games/${gameId}/members/${p2.publicId}/kick`, gm.cookie);
    await call('post', `/api/games/${gameId}/members/${p3.publicId}/ban`, gm.cookie);
    for (const p of [p1, p2, p3]) expect(await pins(p.id, gameId)).toHaveLength(0);
  });

  it('account deletion', async () => {
    const { gameId, p1 } = await setup();
    await pin(gameId, p1.cookie);
    expect(await pins(p1.id, gameId)).toHaveLength(1);
    const del = await call('delete', '/api/me', p1.cookie);
    expect(del.status).toBeLessThan(300);
    expect(await pins(p1.id, gameId)).toHaveLength(0);
  });
});
