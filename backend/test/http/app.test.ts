import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createDb } from '../../src/db/client.js';
import { createRedis } from '../../src/redis/client.js';

const base = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = createRedis(`${base.replace(/\/\d+$/, '')}/15`);
const { db, pool } = createDb(process.env.DATABASE_URL_TEST ?? 'mysql://x:x@localhost:3306/nri_test');

function makeApp(extra: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://x:x@localhost:3306/nri_test',
    REDIS_URL: 'redis://localhost:6379/15',
    IDENTITY_PEPPER: 'pepper',
    INTERNAL_API_KEY: 'key',
    ...extra,
  });
  return createApp({ env, db, redis });
}

function csrfToken(setCookie: string[] | undefined): string {
  return /nri_csrf=([^;]+)/.exec((setCookie ?? []).join(';'))![1]!;
}

beforeEach(async () => {
  await redis.flushdb(); // лише db 15
});
afterAll(async () => {
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
});

describe('loadEnv', () => {
  it('lists missing required keys', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('treats telegram/google/dev keys as optional', () => {
    const env = loadEnv({
      DATABASE_URL: 'a',
      REDIS_URL: 'b',
      IDENTITY_PEPPER: 'c',
      INTERNAL_API_KEY: 'd',
      TELEGRAM_BOT_TOKEN: '',
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DEV_LOGIN_ENABLED).toBe(false);
    expect(env.RATE_LIMIT_MAX).toBe(300);
    expect(env.RATE_LIMIT_AUTH_MAX).toBe(20);
  });
});

describe('app', () => {
  it('GET /api/health returns ok and sets nri_csrf', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/nri_csrf=/);
  });

  it('sends helmet headers', async () => {
    const res = await request(makeApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects POST without CSRF header, accepts with matching one', async () => {
    const agent = request.agent(makeApp());
    const get = await agent.get('/api/health');
    const token = csrfToken(get.headers['set-cookie'] as unknown as string[]);

    const bad = await agent.post('/api/health-echo').send({});
    expect(bad.status).toBe(403);
    expect(bad.body).toEqual({ error: { code: 'CSRF' } });

    const ok = await agent.post('/api/health-echo').set('X-CSRF-Token', token).send({});
    expect(ok.status).toBe(200);
  });

  it('skips CSRF for /api/internal/*', async () => {
    const res = await request(makeApp()).post('/api/internal/ping').send({});
    expect(res.status).toBe(404);
  });

  it('maps AppError (sync and async) to its status and code', async () => {
    const app = makeApp();
    for (const path of ['/api/boom/app-error', '/api/boom/async']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'NICKNAME_TAKEN' } });
    }
  });

  it('maps ZodError to 400 VALIDATION with issues', async () => {
    const res = await request(makeApp()).get('/api/boom/zod');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('hides unknown errors behind a 500 without stack', async () => {
    const res = await request(makeApp()).get('/api/boom/unknown');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret internals|stack/);
  });

  it('maps malformed JSON to 400 VALIDATION', async () => {
    const agent = request.agent(makeApp());
    const get = await agent.get('/api/health');
    const token = csrfToken(get.headers['set-cookie'] as unknown as string[]);
    const res = await agent
      .post('/api/health-echo')
      .set('X-CSRF-Token', token)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('returns 404 NOT_FOUND for unknown routes', async () => {
    const res = await request(makeApp()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  it('rate-limits /api/auth/* with 429 RATE_LIMITED', async () => {
    const app = makeApp({ RATE_LIMIT_AUTH_MAX: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/auth/ping')).status).toBe(200);
    }
    const res = await request(app).get('/api/auth/ping');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: { code: 'RATE_LIMITED' } });
  });

  it('rate-limits the general API', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '2' });
    await request(app).get('/api/health');
    await request(app).get('/api/health');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(429);
  });
});
