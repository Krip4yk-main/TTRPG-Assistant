import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import {
  GAME_UNWATCH_EVENT,
  GAME_WATCH_EVENT,
  SESSION_REVOKED_EVENT,
  type GameWatchAck,
} from '@nri/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import {
  hashToken,
  revokedTokenHashes,
  resolveSession,
  SESSION_COOKIE,
} from '../auth/session.service.js';
import { sessions, users } from '../db/schema/index.js';
import { gameMembersRoom, gameRoom, watchAccess } from './game-rooms.js';

export interface RealtimeHub {
  toUser(userId: number, event: string, payload: unknown): void;
  toRoom(room: string, event: string, payload: unknown): void;
  /** Розриває всі сокети користувача (на всіх вузлах). */
  disconnectUser(userId: number): void;
  /** Розриває сокети однієї сесії за хешем токена. */
  disconnectSession(tokenHash: string): void;
  /** Усі сокети користувача (на всіх вузлах) входять у кімнату. */
  joinRoom(userId: number, room: string): void;
  /** Усі сокети користувача (на всіх вузлах) виходять із кімнати. */
  leaveRoom(userId: number, room: string): void;
  /** Усі сокети виходять із кімнати (на всіх вузлах). */
  closeRoom(room: string): void;
  /**
   * Перевіряє сесії сокетів ЦЬОГО вузла (сплила, відкликана, користувач забанений/видалений/
   * не активний) і розриває недійсні. Повертає кількість розірваних. Викликається таймером.
   */
  revalidateSockets(): Promise<number>;
  close(): Promise<void>;
}

export const REVALIDATE_EVERY_MS = 5 * 60_000;
/** Скільки ігор один сокет може дивитися одночасно (захист від роздування кімнат). */
export const MAX_WATCHED_GAMES = 50;
/** Ліміт підписок `game.watch` на сокет: відро на 20 жетонів, повне поповнення за 10 с. */
export const WATCH_BURST = 20;
export const WATCH_REFILL_MS = 10_000;
const REVALIDATE_CHUNK = 500;

export type RealtimeOptions = {
  revalidateEveryMs?: number;
  /** Для тестів: межа одночасно переглядуваних ігор на сокет. */
  maxWatchedGames?: number;
  /** Для тестів: місткість відра `game.watch` і час його повного поповнення. */
  watchBurst?: number;
  watchRefillMs?: number;
};

/** Стан підписок сокета — синхронний, щоб межу перевіряти й бронювати до будь-якого await. */
interface WatchState {
  /** Переглядувані ігри разом із тими, чия перевірка ще триває (броня місця). */
  watched: Set<number>;
  /** Ігри, для яких `game.watch` ще виконується (дубль відкидається). */
  inFlight: Set<number>;
  tokens: number;
  refilledAt: number;
}

const logErr = (err: unknown): void => {
  console.error('[realtime] adapter error', err);
};

const userRoom = (id: number) => `user:${id}`;
const sessionRoom = (hash: string) => `sess:${hash}`;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function attachRealtime(
  httpServer: HttpServer,
  deps: Pick<AppDeps, 'env' | 'db' | 'redis'>,
  {
    revalidateEveryMs = REVALIDATE_EVERY_MS,
    maxWatchedGames = MAX_WATCHED_GAMES,
    watchBurst = WATCH_BURST,
    watchRefillMs = WATCH_REFILL_MS,
  }: RealtimeOptions = {},
): RealtimeHub {
  const allowedOrigin = originOf(deps.env.PUBLIC_BASE_URL);
  const pub = deps.redis.duplicate();
  const sub = deps.redis.duplicate();

  const io = new Server(httpServer, {
    cors: { origin: deps.env.PUBLIC_BASE_URL, credentials: true },
    // Захист від cross-site WebSocket hijacking: Origin, якщо є, має збігатися.
    // Відсутній Origin дозволено свідомо (не-браузерні клієнти); автентифікує кука.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, !origin || origin === allowedOrigin);
    },
    adapter: createAdapter(pub, sub),
  });

  // Сесія перевіряється при підключенні; далі — періодично (`revalidateSockets`).
  io.use((socket, next) => {
    void (async () => {
      const token = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
      const user = token ? await resolveSession(deps, token) : null;
      if (!token || !user || user.isBanned) return next(new Error('UNAUTHENTICATED'));
      if (user.status !== 'active') return next(new Error('PROFILE_INCOMPLETE'));
      const hash = hashToken(token);
      socket.data.userId = user.userId;
      socket.data.tokenHash = hash;
      await socket.join([userRoom(user.userId), sessionRoom(hash)]);
      next();
    })().catch(() => next(new Error('UNAUTHENTICATED')));
  });

  const parseGameId = (input: unknown): number | null => {
    const id = (input as { gameId?: unknown } | null)?.gameId;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  io.on('connection', (socket) => {
    const userId = socket.data.userId as number;
    const state: WatchState = {
      watched: new Set(),
      inFlight: new Set(),
      tokens: watchBurst,
      refilledAt: Date.now(),
    };
    const reply = (ack: unknown, value: GameWatchAck) => {
      if (typeof ack === 'function') (ack as (v: GameWatchAck) => void)(value);
    };
    /** Відро жетонів: поповнюється пропорційно часу, `watchBurst` за `watchRefillMs`. */
    const takeToken = (): boolean => {
      const now = Date.now();
      const refill = ((now - state.refilledAt) / watchRefillMs) * watchBurst;
      state.tokens = Math.min(watchBurst, state.tokens + refill);
      state.refilledAt = now;
      if (state.tokens < 1) return false;
      state.tokens -= 1;
      return true;
    };
    const leaveGame = async (gameId: number) => {
      state.watched.delete(gameId);
      await Promise.all([socket.leave(gameRoom(gameId)), socket.leave(gameMembersRoom(gameId))]);
    };

    // Підписка на пінги гри: право перевіряється щоразу заново (колишній учасник не
    // повернеться в `game-members:<id>`); без права — виходимо з обох кімнат гри.
    // Ліміти (частота, дубль у польоті, межа ігор) перевіряються й бронюються синхронно,
    // до першого await, — пачка одночасних підписок не обійде межу.
    socket.on(GAME_WATCH_EVENT, (input: unknown, ack?: unknown) => {
      const gameId = parseGameId(input);
      if (gameId === null) return reply(ack, { ok: false });
      if (state.inFlight.has(gameId)) return reply(ack, { ok: false });
      if (!takeToken()) return reply(ack, { ok: false });
      if (!state.watched.has(gameId) && state.watched.size >= maxWatchedGames) {
        return reply(ack, { ok: false });
      }
      state.watched.add(gameId);
      state.inFlight.add(gameId);
      void (async (): Promise<GameWatchAck> => {
        const access = await watchAccess(deps, userId, gameId);
        if (!access.watch) {
          await leaveGame(gameId);
          return { ok: false };
        }
        if (!access.members) await socket.leave(gameMembersRoom(gameId));
        await socket.join(
          access.members ? [gameRoom(gameId), gameMembersRoom(gameId)] : gameRoom(gameId),
        );
        // `game.unwatch` під час перевірки скасовує підписку.
        if (!state.watched.has(gameId)) {
          await leaveGame(gameId);
          return { ok: false };
        }
        // Повторна перевірка після входу закриває гонку з виключенням: якщо виселення
        // (після коміту) пройшло між першою перевіркою й входом, тут членства вже немає.
        if (access.members && !(await watchAccess(deps, userId, gameId)).members) {
          await socket.leave(gameMembersRoom(gameId));
          return { ok: true, members: false };
        }
        return { ok: true, members: access.members };
      })()
        .catch(async (err: unknown) => {
          console.error('[realtime] game.watch failed', err);
          await leaveGame(gameId).catch(() => {});
          return { ok: false } as const;
        })
        .then((value) => {
          state.inFlight.delete(gameId);
          reply(ack, value);
        });
    });
    socket.on(GAME_UNWATCH_EVENT, (input: unknown, ack?: unknown) => {
      const gameId = parseGameId(input);
      if (gameId === null) return reply(ack, { ok: false });
      void leaveGame(gameId)
        .then(() => reply(ack, { ok: true, members: false }))
        .catch(() => reply(ack, { ok: false }));
    });
    socket.on('disconnect', () => {
      state.watched.clear();
      state.inFlight.clear();
    });
  });

  /**
   * Пачкою: які з хешів досі дійсні (рядок сесії не сплив, користувач активний і не
   * забанений, немає надгробка відкликання). Без ковзного продовження: відкритий сокет сам
   * по собі не подовжує сесію.
   */
  async function validHashes(hashes: string[]): Promise<Set<string>> {
    const ok = new Set<string>();
    for (let i = 0; i < hashes.length; i += REVALIDATE_CHUNK) {
      const chunk = hashes.slice(i, i + REVALIDATE_CHUNK);
      const rows = await deps.db
        .select({ hash: sessions.tokenHash })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            inArray(sessions.tokenHash, chunk),
            gt(sessions.expiresAt, new Date()),
            eq(users.status, 'active'),
            eq(users.isBanned, false),
          ),
        );
      const revoked = await revokedTokenHashes(
        deps,
        rows.map((r) => r.hash),
      );
      for (const r of rows) if (!revoked.has(r.hash)) ok.add(r.hash);
    }
    return ok;
  }

  async function revalidateSockets(): Promise<number> {
    // Лише локальні сокети: кожен вузол перевіряє свої (без міжвузлових запитів адаптера).
    const local = [...io.of('/').sockets.values()];
    const hashes = [...new Set(local.map((s) => s.data.tokenHash as string | undefined))].filter(
      (h): h is string => !!h,
    );
    if (hashes.length === 0) return 0;
    const ok = await validHashes(hashes);
    let dropped = 0;
    for (const s of local) {
      if (ok.has(s.data.tokenHash as string)) continue;
      s.emit(SESSION_REVOKED_EVENT);
      s.disconnect(true);
      dropped++;
    }
    return dropped;
  }

  let revalidating = false;
  const timer = setInterval(() => {
    if (revalidating) return;
    revalidating = true;
    revalidateSockets()
      .catch((err: unknown) => console.error('[realtime] revalidate failed', err))
      .finally(() => (revalidating = false));
  }, revalidateEveryMs);
  timer.unref();

  return {
    revalidateSockets,
    toUser: (userId, event, payload) => void io.to(userRoom(userId)).emit(event, payload),
    toRoom: (room, event, payload) => void io.to(room).emit(event, payload),
    disconnectUser: (userId) => {
      try {
        // Клієнт має дізнатися причину до розриву (інакше не відрізнить від мережевого збою).
        io.in(userRoom(userId)).emit(SESSION_REVOKED_EVENT);
        io.in(userRoom(userId)).disconnectSockets(true);
      } catch (err) {
        logErr(err);
      }
    },
    joinRoom: (userId, room) => {
      try {
        io.in(userRoom(userId)).socketsJoin(room);
      } catch (err) {
        logErr(err);
      }
    },
    leaveRoom: (userId, room) => {
      try {
        io.in(userRoom(userId)).socketsLeave(room);
      } catch (err) {
        logErr(err);
      }
    },
    closeRoom: (room) => {
      try {
        io.in(room).socketsLeave(room);
      } catch (err) {
        logErr(err);
      }
    },
    disconnectSession: (hash) => {
      try {
        io.in(sessionRoom(hash)).emit(SESSION_REVOKED_EVENT);
        io.in(sessionRoom(hash)).disconnectSockets(true);
      } catch (err) {
        logErr(err);
      }
    },
    close: async () => {
      clearInterval(timer);
      await io.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
