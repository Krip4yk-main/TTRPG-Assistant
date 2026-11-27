import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import { oauthNavErrorBase } from '../auth/oauth-nav.js';
import { AppError } from './errors.js';

export const CSRF_COOKIE = 'nri_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfProtection(env: Pick<Env, 'NODE_ENV'>): RequestHandler {
  return (req, res, next) => {
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (req.method === 'GET' && !cookie) {
      res.cookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), {
        httpOnly: false,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        path: '/',
      });
    }
    if (UNSAFE.has(req.method) && !req.path.startsWith('/api/internal/')) {
      const header = req.get(CSRF_HEADER);
      if (!cookie || !header || header !== cookie) {
        next(new AppError(403, 'CSRF'));
        return;
      }
    }
    next();
  };
}

/** Чи містить запит дійсний `X-Internal-Key` (довжина — перед timingSafeEqual). */
export function hasValidInternalKey(req: Request, key: string): boolean {
  const given = Buffer.from(req.get('x-internal-key') ?? '');
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function limiter(
  redis: Redis,
  prefix: string,
  windowSec: number,
  limit: number,
  skip?: (req: Request) => boolean,
  keyGenerator?: (req: Request) => string,
): RequestHandler {
  return rateLimit({
    windowMs: windowSec * 1000,
    limit,
    skip,
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<never>,
    }),
    handler: (req, res, next) => {
      // OAuth start/callback — навігація браузера: редирект замість JSON.
      const base = oauthNavErrorBase(req);
      if (base) {
        res.redirect(`${base}?error=RATE_LIMITED`);
        return;
      }
      next(new AppError(429, 'RATE_LIMITED'));
    },
  });
}

export const IMAGE_CHECK_MAX = 20;
export const IMAGE_CHECK_WINDOW_SEC = 3600;

function hasImageUrl(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const v = (body as Record<string, unknown>).coverUrl;
  return typeof v === 'string' && v.length > 0;
}

export function rateLimiters(env: Env, redis: Redis) {
  return {
    // Бот із дійсним ключем не обмежується; запити з хибним ключем лишаються під лімітом.
    general: limiter(
      redis,
      'general',
      env.RATE_LIMIT_WINDOW_SEC,
      env.RATE_LIMIT_MAX,
      (req) => req.path.startsWith('/internal/') && hasValidInternalKey(req, env.INTERNAL_API_KEY),
    ),
    auth: limiter(redis, 'auth', env.RATE_LIMIT_WINDOW_SEC, env.RATE_LIMIT_AUTH_MAX),
    /**
     * Перевірки посилань на картинки (кожна — зовнішній запит): ≤ 20 на годину на користувача.
     * Монтується після сесії й розбору тіла; рахуються лише запити з непорожнім `coverUrl`
     * (без сесії — пропуск: такий запит однаково відхилить `requireAuth`).
     */
    imageCheck: limiter(
      redis,
      'image',
      IMAGE_CHECK_WINDOW_SEC,
      IMAGE_CHECK_MAX,
      (req) => !req.user || !hasImageUrl(req.body),
      (req) => `u:${req.user!.userId}`,
    ),
  };
}
