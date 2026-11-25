import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { SESSION_REVOKED_EVENT } from '@nri/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import {
  hashToken,
  revokedTokenHashes,
  resolveSession,
  SESSION_COOKIE,
} from '../auth/session.service.js';
import { sessions, users } from '../db/schema/index.js';

export interface RealtimeHub {
  toUser(userId: number, event: string, payload: unknown): void;
  toRoom(room: string, event: string, payload: unknown): void;
  /** Розриває всі сокети користувача (на всіх вузлах). */
  disconnectUser(userId: number): void;
  /** Розриває сокети однієї сесії за хешем токена. */
  disconnectSession(tokenHash: string): void;
  /**
   * Перевіряє сесії сокетів ЦЬОГО вузла (сплила, відкликана, користувач забанений/видалений/
   * не активний) і розриває недійсні. Повертає кількість розірваних. Викликається таймером.
   */
  revalidateSockets(): Promise<number>;
  close(): Promise<void>;
}

export const REVALIDATE_EVERY_MS = 5 * 60_000;
const REVALIDATE_CHUNK = 500;

export type RealtimeOptions = { revalidateEveryMs?: number };

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
  { revalidateEveryMs = REVALIDATE_EVERY_MS }: RealtimeOptions = {},
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
