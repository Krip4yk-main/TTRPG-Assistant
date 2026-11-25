import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  GAME_CHANGED_EVENT,
  GAME_UNWATCH_EVENT,
  GAME_WATCH_EVENT,
  toZoned,
  zonedToUtc,
  type GameChangedPing,
  type GameWatchAck,
} from '@nri/shared';
import type { AppDeps } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/auth/session.service.js';
import { gameSessions } from '../../src/db/schema/index.js';
import { createServer } from 'node:http';
import { createHttpServer } from '../../src/http-server.js';
import { attachRealtime, type RealtimeHub } from '../../src/realtime/socket.js';
import { deleteAccount } from '../../src/users/users.service.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

let deps: AppDeps;
let server: Server;
let hub: RealtimeHub;
let url: string;
let h: ReturnType<typeof harness>;
const clients: Socket[] = [];

beforeEach(async () => {
  deps = await testDeps();
  await deps.redis.flushdb();
  await resetDb(deps.db);
  server = createHttpServer(deps);
  hub = deps.realtime!;
  // Окремий екземпляр Express на тих самих deps: пінги йдуть через `deps.realtime`.
  h = harness(deps, createApp(deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub.close();
  await new Promise<void>((r) => server.close(() => r()));
  await deps.redis.flushdb();
  await closeDeps(deps);
});

type User = Awaited<ReturnType<ReturnType<typeof harness>['userWithAge']>>;

/** Сокет користувача з журналом отриманих `game.changed`. */
async function socketOf(userId: number): Promise<{ s: Socket; pings: GameChangedPing[] }> {
  const { token } = await createSession(deps, userId, {});
  const s = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie: `nri_sid=${token}` },
  });
  clients.push(s);
  const pings: GameChangedPing[] = [];
  s.on(GAME_CHANGED_EVENT, (p: GameChangedPing) => pings.push(p));
  await new Promise<void>((r) => s.once('connect', () => r()));
  return { s, pings };
}

const watch = (s: Socket, gameId: unknown) =>
  s.timeout(5000).emitWithAck(GAME_WATCH_EVENT, { gameId }) as Promise<GameWatchAck>;

/**
 * Дочекатися, поки до сокетів дійдуть усі пінги, надіслані раніше: маркер іде тим самим
 * шляхом (локальний вузол зберігає порядок для сокета).
 */
async function settle(...users: { s: Socket; id: number }[]): Promise<void> {
  await Promise.all(
    users.map(
      (u) =>
        new Promise<void>((r) => {
          u.s.once('sync', () => r());
          hub.toUser(u.id, 'sync', {});
        }),
    ),
  );
}

function soon() {
  const TZ = 'Europe/Kyiv';
  const z = toZoned(new Date(Date.now() + 2 * 86_400_000), TZ);
  const start = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour: 19, minute: 0 }, TZ);
  return { startsAt: start.toISOString(), weekdays: [z.weekday] };
}

async function join(gm: User, gameId: number, p: User): Promise<number> {
  const a = await h.call('post', `/api/games/${gameId}/applications`, p.cookie, {
    warningsAccepted: true,
    answers: [],
  });
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  const ok = await h.call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status}`);
  return a.body.id as number;
}

async function firstSession(gameId: number) {
  const [s] = await deps.db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId));
  return s!;
}

const reschedule = async (gm: User, sessionId: number, startsAt: Date) => {
  const r = await h.call('post', `/api/sessions/${sessionId}/reschedule`, gm.cookie, {
    startsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
  });
  expect(r.status).toBe(200);
};

describe('game.watch access', () => {
  it('stranger can watch a published game (details only), not hidden/unpublished/age-restricted', async () => {
    const gm = await h.userWithAge(30);
    const stranger = await h.userWithAge(25);
    const young = await h.userWithAge(16);
    const published = await h.createGame(gm.cookie, {}, true);
    const draft = await h.createGame(gm.cookie);
    const adult = await h.createGame(gm.cookie, { ageRating: '18+' }, true);
    const cancelledDraft = await h.createGame(gm.cookie);
    await h.call('post', `/api/games/${cancelledDraft}/cancel`, gm.cookie);

    const st = await socketOf(stranger.id);
    expect(await watch(st.s, published)).toEqual({ ok: true, members: false });
    expect(await watch(st.s, draft)).toEqual({ ok: false });
    expect(await watch(st.s, cancelledDraft)).toEqual({ ok: false });
    expect(await watch(st.s, 999_999)).toEqual({ ok: false });
    expect(await watch(st.s, 'x')).toEqual({ ok: false });
    expect(await watch(st.s, adult)).toEqual({ ok: true, members: false });
    const y = await socketOf(young.id);
    expect(await watch(y.s, adult)).toEqual({ ok: false });
    expect(await watch(y.s, published)).toEqual({ ok: true, members: false });

    // GM бачить свою чернетку й отримує приватні пінги.
    const g = await socketOf(gm.id);
    expect(await watch(g.s, draft)).toEqual({ ok: true, members: true });

    // Зміна чернетки не доходить до того, кому відмовлено.
    await h.call('patch', `/api/games/${draft}`, gm.cookie, { title: 'Інша' });
    await h.call('patch', `/api/games/${adult}`, gm.cookie, { title: 'Інша' });
    await settle({ s: st.s, id: stranger.id }, { s: y.s, id: young.id }, { s: g.s, id: gm.id });
    expect(st.pings).toEqual([{ gameId: adult, scope: 'details' }]);
    expect(y.pings).toEqual([]);
    expect(g.pings).toEqual([{ gameId: draft, scope: 'details' }]);
  });

  it('ping payload is exactly {gameId, scope}', async () => {
    const gm = await h.userWithAge(30);
    const stranger = await h.userWithAge(25);
    const gameId = await h.createGame(gm.cookie, {}, true);
    const st = await socketOf(stranger.id);
    await watch(st.s, gameId);
    const raw = new Promise<unknown>((r) => st.s.once(GAME_CHANGED_EVENT, r));
    await h.call('patch', `/api/games/${gameId}`, gm.cookie, { title: 'Нова назва' });
    const got = await raw;
    expect(got).toStrictEqual({ gameId, scope: 'details' });
    expect(Object.keys(got as object).sort()).toEqual(['gameId', 'scope']);
  });

  it('unwatch stops pings', async () => {
    const gm = await h.userWithAge(30);
    const stranger = await h.userWithAge(25);
    const gameId = await h.createGame(gm.cookie, {}, true);
    const st = await socketOf(stranger.id);
    await watch(st.s, gameId);
    expect(await st.s.timeout(5000).emitWithAck(GAME_UNWATCH_EVENT, { gameId })).toEqual({
      ok: true,
      members: false,
    });
    await h.call('patch', `/api/games/${gameId}`, gm.cookie, { title: 'Нова назва' });
    await settle({ s: st.s, id: stranger.id });
    expect(st.pings).toEqual([]);
  });
});

describe('game-members room (Review Focus 4)', () => {
  it('member gets private pings; stranger watching gets only details', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25);
    const stranger = await h.userWithAge(27);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const m = await socketOf(p.id);
    const st = await socketOf(stranger.id);
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: true });
    expect(await watch(st.s, gameId)).toEqual({ ok: true, members: false });
    const s = await firstSession(gameId);
    await reschedule(gm, s.id, s.startsAt);
    await settle({ s: m.s, id: p.id }, { s: st.s, id: stranger.id });
    expect(m.pings).toEqual([
      { gameId, scope: 'sessions' },
      { gameId, scope: 'details' },
    ]);
    expect(st.pings).toEqual([{ gameId, scope: 'details' }]);
  });

  it("kicked member's sockets leave game-members at once; re-watch does not rejoin", async () => {
    const gm = await h.userWithAge(30, 'Майстер');
    const p = await h.userWithAge(25, 'Гравець');
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const m = await socketOf(p.id);
    const m2 = await socketOf(p.id); // друга вкладка
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: true });
    expect(await watch(m2.s, gameId)).toEqual({ ok: true, members: true });
    const { publicId } = (await h.call('get', `/api/games/${gameId}/members`, gm.cookie))
      .body[0] as { publicId: string };
    expect(
      (await h.call('post', `/api/games/${gameId}/members/${publicId}/kick`, gm.cookie)).status,
    ).toBe(204);
    await settle({ s: m.s, id: p.id }, { s: m2.s, id: p.id });
    // Особистий пінг про зміну складу (щоб сторінка перезапитала вже обмежений вид).
    expect(m.pings).toContainEqual({ gameId, scope: 'members' });
    m.pings.length = 0;
    m2.pings.length = 0;
    const s = await firstSession(gameId);
    await reschedule(gm, s.id, s.startsAt);
    await settle({ s: m.s, id: p.id }, { s: m2.s, id: p.id });
    // Лишились лише в `game:<id>`: публічні `details`, без `sessions`.
    expect(m.pings).toEqual([{ gameId, scope: 'details' }]);
    expect(m2.pings).toEqual([{ gameId, scope: 'details' }]);
    // Колишній учасник не повертається в `game-members:<id>` повторною підпискою.
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: false });
    m.pings.length = 0;
    await reschedule(gm, s.id, new Date(s.startsAt.getTime() + 3_600_000));
    await settle({ s: m.s, id: p.id });
    expect(m.pings).toEqual([{ gameId, scope: 'details' }]);
  });

  it('former member (left) cannot join game-members', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const m = await socketOf(p.id);
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: true });
    const left = await h.call('post', `/api/games/${gameId}/leave`, p.cookie, {
      noteForGm: 'Не встигаю, вибачте',
    });
    expect(left.status).toBe(204);
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: false });
    await settle({ s: m.s, id: p.id });
    m.pings.length = 0;
    const s = await firstSession(gameId);
    await reschedule(gm, s.id, s.startsAt);
    await settle({ s: m.s, id: p.id });
    expect(m.pings.some((x) => x.scope === 'sessions')).toBe(false);
  });

  it('banned member is evicted; approved applicant joins game-members immediately', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25, 'Бан');
    const q = await h.userWithAge(26);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const m = await socketOf(p.id);
    const n = await socketOf(q.id);
    await watch(m.s, gameId);
    expect(await watch(n.s, gameId)).toEqual({ ok: true, members: false });
    // Затвердження: сокети нового учасника одразу в `game-members`.
    await join(gm, gameId, q);
    const { publicId } = (await h.call('get', `/api/games/${gameId}/members`, gm.cookie))
      .body[0] as { publicId: string };
    await h.call('post', `/api/games/${gameId}/members/${publicId}/ban`, gm.cookie);
    await settle({ s: m.s, id: p.id }, { s: n.s, id: q.id });
    m.pings.length = 0;
    n.pings.length = 0;
    const s = await firstSession(gameId);
    await reschedule(gm, s.id, s.startsAt);
    await settle({ s: m.s, id: p.id }, { s: n.s, id: q.id });
    expect(m.pings).toEqual([{ gameId, scope: 'details' }]);
    expect(n.pings).toEqual([
      { gameId, scope: 'sessions' },
      { gameId, scope: 'details' },
    ]);
  });

  it('game cancel closes game-members; re-watch is details-only', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    const m = await socketOf(p.id);
    await watch(m.s, gameId);
    expect((await h.call('post', `/api/games/${gameId}/cancel`, gm.cookie)).status).toBe(200);
    await settle({ s: m.s, id: p.id });
    expect(m.pings).toContainEqual({ gameId, scope: 'details' });
    expect(await watch(m.s, gameId)).toEqual({ ok: true, members: false });
  });

  it('account deletion pings remaining members', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25);
    const q = await h.userWithAge(26);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, p);
    await join(gm, gameId, q);
    const n = await socketOf(q.id);
    await watch(n.s, gameId);
    await deleteAccount(deps, p.id);
    await settle({ s: n.s, id: q.id });
    expect(n.pings).toContainEqual({ gameId, scope: 'members' });
  });
});

describe('applications and rsvp pings — personal rooms only', () => {
  it('applications go to GM and applicant only; rsvp to GM and the member only', async () => {
    const gm = await h.userWithAge(30);
    const p = await h.userWithAge(25);
    const q = await h.userWithAge(26);
    const stranger = await h.userWithAge(27);
    const gameId = await h.createGame(gm.cookie, soon(), true);
    await join(gm, gameId, q);
    const g = await socketOf(gm.id);
    const a = await socketOf(p.id);
    const other = await socketOf(q.id);
    const st = await socketOf(stranger.id);
    for (const x of [g, a, other, st]) await watch(x.s, gameId);
    const r = await h.call('post', `/api/games/${gameId}/applications`, p.cookie, {
      warningsAccepted: true,
      answers: [],
    });
    expect(r.status).toBe(201);
    await settle(
      { s: g.s, id: gm.id },
      { s: a.s, id: p.id },
      { s: other.s, id: q.id },
      { s: st.s, id: stranger.id },
    );
    expect(g.pings).toEqual([{ gameId, scope: 'applications' }]);
    expect(a.pings).toEqual([{ gameId, scope: 'applications' }]);
    expect(other.pings).toEqual([]);
    expect(st.pings).toEqual([]);

    for (const x of [g, a, other, st]) x.pings.length = 0;
    const s = await firstSession(gameId);
    const rsvp = await h.call('put', `/api/sessions/${s.id}/rsvp`, q.cookie, { status: 'going' });
    expect(rsvp.status).toBe(200);
    await settle(
      { s: g.s, id: gm.id },
      { s: a.s, id: p.id },
      { s: other.s, id: q.id },
      { s: st.s, id: stranger.id },
    );
    expect(g.pings).toEqual([{ gameId, scope: 'sessions' }]);
    expect(other.pings).toEqual([{ gameId, scope: 'sessions' }]);
    expect(a.pings).toEqual([]);
    expect(st.pings).toEqual([]);
  });
});

describe('game.watch limits', () => {
  /** Окремий сервер із малими межами (cap 3; відро 10 жетонів без поповнення в межах тесту). */
  async function limitedServer() {
    const srv = createServer();
    const limited = attachRealtime(srv, deps, {
      maxWatchedGames: 3,
      watchBurst: 10,
      watchRefillMs: 3_600_000,
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        await limited.close();
        await new Promise<void>((r) => srv.close(() => r()));
      },
    };
  }

  async function limitedSocket(base: string, userId: number): Promise<Socket> {
    const { token } = await createSession(deps, userId, {});
    const s = connect(base, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie: `nri_sid=${token}` },
    });
    clients.push(s);
    await new Promise<void>((r) => s.once('connect', () => r()));
    return s;
  }

  async function games(n: number): Promise<number[]> {
    const gm = await h.userWithAge(30);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(await h.createGame(gm.cookie, {}, true));
    return ids;
  }

  it('concurrent burst cannot exceed the cap; re-watch of a watched game and unwatch free a slot', async () => {
    const ids = await games(5);
    const u = await h.userWithAge(25);
    const srv = await limitedServer();
    try {
      const s = await limitedSocket(srv.url, u.id);
      // Усі 5 одночасно: броня синхронна, тож рівно 3 успішні.
      const acks = await Promise.all(ids.map((id) => watch(s, id)));
      const ok = ids.filter((_, i) => acks[i]!.ok);
      expect(ok).toHaveLength(3);
      // Уже переглядувана — дозволено; нова понад межу — ні.
      expect(await watch(s, ok[0])).toEqual({ ok: true, members: false });
      const rest = ids.filter((id) => !ok.includes(id));
      expect(await watch(s, rest[0])).toEqual({ ok: false });
      await s.timeout(5000).emitWithAck(GAME_UNWATCH_EVENT, { gameId: ok[1] });
      expect(await watch(s, rest[0])).toEqual({ ok: true, members: false });
    } finally {
      await srv.close();
    }
  });

  it('denied watch releases its reservation; duplicate in-flight watch is dropped', async () => {
    const [a, b, c] = await games(3);
    const u = await h.userWithAge(25);
    const srv = await limitedServer();
    try {
      const s = await limitedSocket(srv.url, u.id);
      // Неіснуючі ігри не займають місць після відмови.
      expect(await watch(s, 999_998)).toEqual({ ok: false });
      expect(await watch(s, 999_999)).toEqual({ ok: false });
      const [first, dup] = await Promise.all([watch(s, a), watch(s, a)]);
      expect([first, dup]).toEqual([{ ok: true, members: false }, { ok: false }]);
      expect(await watch(s, b)).toEqual({ ok: true, members: false });
      expect(await watch(s, c)).toEqual({ ok: true, members: false });
    } finally {
      await srv.close();
    }
  });

  it('rate limit: watches beyond the token bucket are refused', async () => {
    const [a] = await games(1);
    const u = await h.userWithAge(25);
    const srv = await limitedServer();
    try {
      const s = await limitedSocket(srv.url, u.id);
      for (let i = 0; i < 10; i++) expect(await watch(s, a)).toEqual({ ok: true, members: false });
      expect(await watch(s, a)).toEqual({ ok: false });
    } finally {
      await srv.close();
    }
  });
});
