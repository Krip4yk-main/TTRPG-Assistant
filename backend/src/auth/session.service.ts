import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { Env } from '../config/env.js';
import { sessions, users } from '../db/schema/index.js';

export type Role = typeof users.$inferSelect.role;
export type UserStatus = typeof users.$inferSelect.status;

export type SessionUser = {
  sessionId: number;
  userId: number;
  role: Role;
  status: UserStatus;
  isBanned: boolean;
  birthDate: string | null;
};

export const SESSION_COOKIE = 'nri_sid';
const CACHE_TTL_SEC = 5 * 60;
const SLIDE_INTERVAL_SEC = 10 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

type Deps = Pick<AppDeps, 'env' | 'db' | 'redis'> & Pick<Partial<AppDeps>, 'realtime'>;
type CacheEntry = { user: SessionUser; exp: number };

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const sessKey = (hash: string) => `sess:${hash}`;
const slideKey = (hash: string) => `slide:${hash}`;
const revokedKey = (hash: string) => `revoked:${hash}`;
// Інваріант: надгробок живе довше за кеш, тож запис, що «завис», не переживе надгробок.
const REVOKED_TTL_SEC = CACHE_TTL_SEC + 60;
const userSetKey = (userId: number) => `usess:${userId}`;

export async function createSession(
  { env, db, redis }: Deps,
  userId: number,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * DAY_MS);
  await db.insert(sessions).values({
    userId,
    tokenHash,
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 255),
    ip: meta.ip?.slice(0, 45),
  });
  // Щойно створена сесія не потребує одразу «ковзання».
  await redis.set(slideKey(tokenHash), '1', 'EX', SLIDE_INTERVAL_SEC);
  await redis
    .multi()
    .sadd(userSetKey(userId), tokenHash)
    .expire(userSetKey(userId), env.SESSION_TTL_DAYS * 86400)
    .exec();
  return { token, expiresAt };
}

/** Які з хешів токенів мають надгробок відкликання (`revokeSession`/`revokeTokenHashes`). */
export async function revokedTokenHashes(
  { redis }: Pick<Deps, 'redis'>,
  hashes: string[],
): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const marks = await redis.mget(...hashes.map(revokedKey));
  return new Set(hashes.filter((_, i) => marks[i] !== null));
}

export type ResolvedSession = { user: SessionUser; slidTo: Date | null };

/**
 * Кеш: `sess:<hash>` (TTL 5 хв). Якщо is_banned виставлено напряму SQL (повз banUser),
 * застарілість обмежена TTL кешу (≤5 хв). Для бану користуватися banUser().
 * `slidTo` повертається лише якщо сесію щойно продовжено (для оновлення куки).
 */
export async function resolveSessionDetailed(
  { env, db, redis }: Deps,
  token: string,
): Promise<ResolvedSession | null> {
  const hash = hashToken(token);
  let user: SessionUser | null = null;

  // Надгробок відкликаної сесії: не довіряємо кешу й нічого не пишемо в нього.
  if (await redis.exists(revokedKey(hash))) return null;

  const cached = await redis.get(sessKey(hash));
  if (cached) {
    const entry = JSON.parse(cached) as CacheEntry;
    if (entry.exp > Date.now()) user = entry.user;
  }

  if (!user) {
    const [row] = await db
      .select({
        sessionId: sessions.id,
        userId: users.id,
        role: users.role,
        status: users.status,
        isBanned: users.isBanned,
        birthDate: users.birthDate,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date())));
    if (!row || row.status === 'deleted') return null;
    user = {
      sessionId: row.sessionId,
      userId: row.userId,
      role: row.role,
      status: row.status,
      isBanned: row.isBanned,
      birthDate: row.birthDate,
    };
    const entry: CacheEntry = { user, exp: row.expiresAt.getTime() };
    await redis
      .multi()
      .set(sessKey(hash), JSON.stringify(entry), 'EX', CACHE_TTL_SEC)
      .sadd(userSetKey(user.userId), hash)
      .expire(userSetKey(user.userId), env.SESSION_TTL_DAYS * 86400)
      .exec();
    // Гонка: відкликання/бан могли відбутися між читанням БД і записом кешу.
    if (await redis.exists(revokedKey(hash))) {
      await redis.del(sessKey(hash));
      return null;
    }
    const [fresh] = await db
      .select({ isBanned: users.isBanned })
      .from(users)
      .where(eq(users.id, user.userId));
    if (!fresh || fresh.isBanned !== user.isBanned) {
      await redis.del(sessKey(hash));
      if (!fresh) return null;
      user = { ...user, isBanned: fresh.isBanned };
    }
  }

  // Ковзне продовження — не частіше ніж раз на 10 хв.
  let slidTo: Date | null = null;
  const acquired = await redis.set(slideKey(hash), '1', 'EX', SLIDE_INTERVAL_SEC, 'NX');
  if (acquired === 'OK') {
    const now = new Date();
    slidTo = new Date(now.getTime() + env.SESSION_TTL_DAYS * DAY_MS);
    const [res] = await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: slidTo })
      .where(and(eq(sessions.id, user.sessionId), gt(sessions.expiresAt, now)));
    if (res.affectedRows === 0) {
      // Сесію видалено/протерміновано — не воскрешаємо кеш і не перевидаємо куку.
      await redis.del(sessKey(hash));
      return null;
    }
    // Кеш НЕ перезаписуємо застарілим user (міг бути забанений між читанням і записом):
    // скидаємо запис, наступний запит перечитає користувача з БД.
    await redis.del(sessKey(hash));
  }
  return { user, slidTo };
}

export async function resolveSession(deps: Deps, token: string): Promise<SessionUser | null> {
  return (await resolveSessionDetailed(deps, token))?.user ?? null;
}

export async function revokeSession(
  { db, redis, realtime }: Deps,
  token: string,
  userId?: number,
): Promise<void> {
  const hash = hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, hash));
  // Порядок важливий: спершу надгробок, потім видалення кешу (див. resolveSessionDetailed).
  await redis.set(revokedKey(hash), '1', 'EX', REVOKED_TTL_SEC);
  const multi = redis.multi().del(sessKey(hash), slideKey(hash));
  if (userId !== undefined) multi.srem(userSetKey(userId), hash);
  await multi.exec();
  realtime?.disconnectSession(hash);
}

/** Лише очищає Redis-кеш сесій користувача (рядки БД лишаються). */
export async function evictUserSessionCache({ redis }: Deps, userId: number): Promise<void> {
  const hashes = await redis.smembers(userSetKey(userId));
  const keys = hashes.flatMap((h) => [sessKey(h), slideKey(h)]);
  if (keys.length) await redis.del(...keys);
}

/**
 * Відкликає конкретні сесії за хешами токенів: надгробок, потім видалення кешу.
 * Рядки БД не чіпає (викликач видаляє їх сам, напр. у транзакції).
 */
export async function revokeTokenHashes(
  { redis }: Pick<Deps, 'redis'>,
  hashes: Iterable<string>,
): Promise<void> {
  for (const h of hashes) {
    await redis.set(revokedKey(h), '1', 'EX', REVOKED_TTL_SEC);
    await redis.del(sessKey(h), slideKey(h));
  }
}

export async function revokeAllUserSessions(
  { db, redis, realtime }: Deps,
  userId: number,
): Promise<void> {
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  const members = await redis.smembers(userSetKey(userId));
  const hashes = new Set([...members, ...rows.map((r) => r.tokenHash)]);
  const purge = (hs: Iterable<string>) => revokeTokenHashes({ redis }, hs);
  await purge(hashes);
  // Вхід під час logout-all: додаємо те, що з'явилося в сеті після першого читання.
  const late = (await redis.smembers(userSetKey(userId))).filter((h) => !hashes.has(h));
  await purge(late);
  await redis.del(userSetKey(userId));
  realtime?.disconnectUser(userId);
}

export function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: Date,
  env: Pick<Env, 'NODE_ENV'>,
): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}
