import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { z } from 'zod';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import type { Redis } from './redis/client.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import { csrfProtection, rateLimiters } from './http/security.js';

export type AppDeps = { env: Env; db: Db; redis: Redis };

export function createApp({ env, redis }: AppDeps): express.Express {
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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Тестові маршрути — лише в NODE_ENV=test.
  if (env.NODE_ENV === 'test') {
    app.post('/api/health-echo', (req, res) => {
      res.json({ ok: true, body: req.body as unknown });
    });
    app.get('/api/auth/ping', (_req, res) => {
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
