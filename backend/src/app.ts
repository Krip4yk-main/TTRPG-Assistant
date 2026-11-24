import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z } from 'zod';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { Redis } from './redis/client.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import type { OAuthProvider } from './auth/providers/oauth.js';
import { authRouter } from './auth/auth.routes.js';
import { loadSession, requireActive, requireAuth } from './auth/session.middleware.js';
import { usersRouter } from './users/users.routes.js';
import { csrfProtection, rateLimiters } from './http/security.js';

export type AppDeps = {
  env: Env;
  db: Db;
  redis: Redis;
  /** DI для тестів; за відсутності будуються з env. */
  oauthProviders?: Record<string, OAuthProvider>;
};

export function createApp(deps: AppDeps): express.Express {
  const { env, redis } = deps;
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  const limits = rateLimiters(env, redis);

  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/auth', limits.auth);
  app.use('/api', limits.general);
  app.use(csrfProtection(env));
  app.use(loadSession(deps));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  const auth = requireAuth(deps);
  app.use('/api/auth', authRouter(deps));
  app.use('/api/me', usersRouter(deps));

  // Тестові маршрути — лише в NODE_ENV=test.
  if (env.NODE_ENV === 'test') {
    app.post('/api/health-echo', (req, res) => {
      res.json({ ok: true, body: req.body as unknown });
    });
    app.get('/api/auth/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/test/protected', auth, (req, res) => {
      res.json({ ok: true, userId: req.user!.userId });
    });
    app.get('/api/test/active', auth, requireActive, (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/api/boom/app-error', () => {
      throw new AppError(409, 'NICKNAME_TAKEN');
    });
    app.get('/api/boom/async', async () => {
      await Promise.resolve();
      throw new AppError(409, 'NICKNAME_TAKEN');
    });
    app.get('/api/boom/zod', () => {
      z.object({ a: z.string() }).parse({});
    });
    app.get('/api/boom/unknown', () => {
      throw new Error('secret internals');
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
