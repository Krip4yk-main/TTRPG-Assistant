import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
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

function limiter(redis: Redis, prefix: string, windowSec: number, limit: number): RequestHandler {
  return rateLimit({
    windowMs: windowSec * 1000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<never>,
    }),
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED')),
  });
}

export function rateLimiters(env: Env, redis: Redis) {
  return {
    general: limiter(redis, 'general', env.RATE_LIMIT_WINDOW_SEC, env.RATE_LIMIT_MAX),
    auth: limiter(redis, 'auth', env.RATE_LIMIT_WINDOW_SEC, env.RATE_LIMIT_AUTH_MAX),
  };
}
