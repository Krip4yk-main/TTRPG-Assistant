import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { devLoginSchema } from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Env } from '../config/env.js';
import { authIdentities, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { isDuplicateKey, resolveLogin } from './identity.service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Лише адреса TCP-сокета; X-Forwarded-* і req.ip ігноруються навмисно. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

/** Запит із проксі-заголовками вважається не локальним (reverse proxy на тому ж хості). */
export function isLocalRequest(req: Pick<Request, 'socket' | 'headers'>): boolean {
  if (PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined)) return false;
  const addr = req.socket?.remoteAddress;
  return typeof addr === 'string' && LOOPBACK.has(addr);
}

type DevEnv = Pick<Env, 'NODE_ENV' | 'DEV_LOGIN_ENABLED' | 'TRUST_PROXY'>;

export const devLoginEnabled = (env: DevEnv): boolean =>
  env.NODE_ENV === 'development' && env.DEV_LOGIN_ENABLED && env.TRUST_PROXY === 0;

/** Гучне попередження, якщо dev-вхід увімкнено, але середовище виглядає небезпечним. */
export function warnDevLoginMisconfig(env: DevEnv): void {
  if (env.DEV_LOGIN_ENABLED && !devLoginEnabled(env)) {
    console.warn(
      '[SECURITY] DEV_LOGIN_ENABLED=true, але NODE_ENV!=development або TRUST_PROXY>0: dev-вхід вимкнено. ' +
        'Не вмикайте DEV_LOGIN_ENABLED поза локальною розробкою.',
    );
  }
}

function ownerKeyMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bodySchema = devLoginSchema.extend({
  nickname: devLoginSchema.shape.nickname.max(32),
});

type StartSession = (req: Request, res: Response, userId: number) => Promise<void>;

/** Монтувати лише коли `devLoginEnabled(env)`. Не локальний запит → 404, як невідомий маршрут. */
export function devLoginRouter(deps: AppDeps, startSession: StartSession): Router {
  const { env, db } = deps;
  const router = Router();

  router.post('/dev-login', async (req, res) => {
    if (!isLocalRequest(req)) throw new AppError(404, 'NOT_FOUND');
    const { nickname, ownerKey } = bodySchema.parse(req.body);

    const [viaIdentity] = await db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, 'dev'), eq(authIdentities.subject, nickname)));
    let userId = viaIdentity?.userId ?? null;
    if (userId === null) {
      const [byNick] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.nickname, nickname));
      // Власник (напр. із seed) без dev-ідентичності входить лише за ключем.
      if (byNick && byNick.role !== 'owner') throw new AppError(409, 'NICKNAME_TAKEN');
      userId = byNick?.id ?? null;
    }

    if (userId !== null) {
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
      if (u.role === 'owner' && !ownerKeyMatches(env.DEV_OWNER_KEY, ownerKey)) {
        throw new AppError(403, 'FORBIDDEN');
      }
      if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
      await startSession(req, res, userId);
      res.json({ user: { id: u.id, status: u.status, nickname: u.nickname, avatarUrl: u.avatarUrl } });
      return;
    }

    const created = await resolveLogin(deps, {
      provider: 'dev',
      subject: nickname,
      displayName: nickname,
    });
    try {
      await db
        .update(users)
        .set({ status: 'active', nickname, birthDate: '2000-01-01' })
        .where(eq(users.id, created.userId));
    } catch (err) {
      // Гонка за нікнейм: прибираємо лише те, що створив цей запит.
      if (created.isNew) {
        await db.delete(authIdentities).where(eq(authIdentities.userId, created.userId));
        await db.delete(users).where(eq(users.id, created.userId));
      }
      if (isDuplicateKey(err)) throw new AppError(409, 'NICKNAME_TAKEN');
      throw err;
    }
    await startSession(req, res, created.userId);
    res.json({ user: { id: created.userId, status: 'active', nickname, avatarUrl: null } });
  });

  return router;
}
