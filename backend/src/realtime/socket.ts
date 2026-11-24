import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import type { AppDeps } from '../app.js';
import { hashToken, resolveSession, SESSION_COOKIE } from '../auth/session.service.js';

export interface RealtimeHub {
  toUser(userId: number, event: string, payload: unknown): void;
  toRoom(room: string, event: string, payload: unknown): void;
  /** Розриває всі сокети користувача (на всіх вузлах). */
  disconnectUser(userId: number): void;
  /** Розриває сокети однієї сесії за хешем токена. */
  disconnectSession(tokenHash: string): void;
  close(): Promise<void>;
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

  // TODO(План 4): сокети не перевіряються повторно після природного спливу сесії.
  io.use((socket, next) => {
    void (async () => {
      const token = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
      const user = token ? await resolveSession(deps, token) : null;
      if (!token || !user || user.isBanned) return next(new Error('UNAUTHENTICATED'));
      if (user.status !== 'active') return next(new Error('PROFILE_INCOMPLETE'));
      socket.data.userId = user.userId;
      await socket.join([userRoom(user.userId), sessionRoom(hashToken(token))]);
      next();
    })().catch(() => next(new Error('UNAUTHENTICATED')));
  });

  return {
    toUser: (userId, event, payload) => void io.to(userRoom(userId)).emit(event, payload),
    toRoom: (room, event, payload) => void io.to(room).emit(event, payload),
    disconnectUser: (userId) => {
      try {
        io.in(userRoom(userId)).disconnectSockets(true);
      } catch (err) {
        logErr(err);
      }
    },
    disconnectSession: (hash) => {
      try {
        io.in(sessionRoom(hash)).disconnectSockets(true);
      } catch (err) {
        logErr(err);
      }
    },
    close: async () => {
      await io.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
