import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { closeDeps, TEST_PEPPER, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;

function makeApp(extra: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL_TEST ?? 'mysql://x:x@localhost:3306/nri_test',
    REDIS_URL: `redis://localhost:6379/${process.env.TEST_REDIS_DB ?? '15'}`,
    IDENTITY_PEPPER: TEST_PEPPER,
    INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
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
  await closeDeps(deps);
});

describe('loadEnv', () => {
  it('lists missing required keys', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it('requires IDENTITY_PEPPER of at least 32 chars', () => {
    const base = {
      DATABASE_URL: 'a',
      REDIS_URL: 'b',
      INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
    };
    expect(() => loadEnv({ ...base, IDENTITY_PEPPER: 'short' })).toThrow(/IDENTITY_PEPPER/);
    expect(loadEnv({ ...base, IDENTITY_PEPPER: TEST_PEPPER }).IDENTITY_PEPPER).toBe(TEST_PEPPER);
  });

  it('treats telegram/google/dev keys as optional', () => {
    const env = loadEnv({
      DATABASE_URL: 'a',
      REDIS_URL: 'b',
      IDENTITY_PEPPER: TEST_PEPPER,
      INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
      TELEGRAM_BOT_TOKEN: '',
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DEV_LOGIN_ENABLED).toBe(false);
    expect(env.RATE_LIMIT_MAX).toBe(300);
    expect(env.RATE_LIMIT_AUTH_MAX).toBe(20);
  });

  it('refuses a non-https PUBLIC_BASE_URL in production only', () => {
    const base = {
      DATABASE_URL: 'a',
      REDIS_URL: 'b',
      IDENTITY_PEPPER: TEST_PEPPER,
      INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
    };
    for (const url of ['http://nri.example.com', 'ftp://nri.example.com', 'nri.example.com']) {
      expect(() => loadEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: url })).toThrow(
        /PUBLIC_BASE_URL \(must be an https:\/\/ URL in production\)/,
      );
    }
    // Без явного значення в production — типовий http://localhost:4200 теж відмова.
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
    const prod = loadEnv({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://nri.example.com',
    });
    expect(prod.PUBLIC_BASE_URL).toBe('https://nri.example.com');
    for (const NODE_ENV of ['development', 'test']) {
      expect(
        loadEnv({ ...base, NODE_ENV, PUBLIC_BASE_URL: 'http://localhost:4200' }).NODE_ENV,
      ).toBe(NODE_ENV);
    }
  });
});

describe('loadEnv DEPLOY_ENV', () => {
  const base = {
    DATABASE_URL: 'a',
    REDIS_URL: 'b',
    IDENTITY_PEPPER: TEST_PEPPER,
    INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
  };
  it('defaults to local and rejects unknown values', () => {
    expect(loadEnv(base).DEPLOY_ENV).toBe('local');
    expect(() => loadEnv({ ...base, DEPLOY_ENV: 'staging' })).toThrow(/DEPLOY_ENV/);
  });
  it('requires production rules for dev and prod', () => {
    for (const DEPLOY_ENV of ['dev', 'prod']) {
      expect(() => loadEnv({ ...base, DEPLOY_ENV })).toThrow(/NODE_ENV \(must be production/);
      expect(() =>
        loadEnv({
          ...base,
          DEPLOY_ENV,
          NODE_ENV: 'production',
          PUBLIC_BASE_URL: 'http://dev.nri.example.com',
        }),
      ).toThrow(/PUBLIC_BASE_URL \(must be an https/);
      const ok = loadEnv({
        ...base,
        DEPLOY_ENV,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://dev.nri.example.com',
      });
      expect(ok.DEPLOY_ENV).toBe(DEPLOY_ENV);
    }
  });
});

describe('app', () => {
  it('GET /api/auth/ping returns ok and sets nri_csrf', async () => {
    const res = await request(makeApp()).get('/api/auth/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((res.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/nri_csrf=/);
  });

  it('sends helmet headers', async () => {
    const res = await request(makeApp()).get('/api/auth/ping');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects POST without CSRF header, accepts with matching one', async () => {
    const agent = request.agent(makeApp());
    const get = await agent.get('/api/auth/ping');
    const token = csrfToken(get.headers['set-cookie'] as unknown as string[]);

    const bad = await agent.post('/api/health-echo').send({});
    expect(bad.status).toBe(403);
    expect(bad.body).toEqual({ error: { code: 'CSRF' } });

    const ok = await agent.post('/api/health-echo').set('X-CSRF-Token', token).send({});
    expect(ok.status).toBe(200);
  });

  it('skips CSRF for /api/internal/*', async () => {
    const app = makeApp();
    // Без CSRF-токена: не 403, а 401 від перевірки внутрішнього ключа.
    expect((await request(app).post('/api/internal/ping').send({})).status).toBe(401);
    const res = await request(app)
      .post('/api/internal/ping')
      .set('X-Internal-Key', 'test-internal-key-0123456789abcdefghij')
      .send({});
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
    const get = await agent.get('/api/auth/ping');
    const token = csrfToken(get.headers['set-cookie'] as unknown as string[]);
    const res = await agent
      .post('/api/health-echo')
      .set('X-CSRF-Token', token)
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('maps body-parser 413/415 to their status with VALIDATION, without logging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const agent = request.agent(makeApp());
      const get = await agent.get('/api/auth/ping');
      const token = csrfToken(get.headers['set-cookie'] as unknown as string[]);
      const big = await agent
        .post('/api/health-echo')
        .set('X-CSRF-Token', token)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ a: 'x'.repeat(200 * 1024) }));
      expect(big.status).toBe(413);
      expect(big.body).toEqual({ error: { code: 'VALIDATION' } });
      const charset = await agent
        .post('/api/health-echo')
        .set('X-CSRF-Token', token)
        .set('Content-Type', 'application/json; charset=bogus')
        .send('{}');
      expect(charset.status).toBe(415);
      expect(charset.body).toEqual({ error: { code: 'VALIDATION' } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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
    await request(app).get('/api/auth/ping');
    await request(app).get('/api/auth/ping');
    const res = await request(app).get('/api/auth/ping');
    expect(res.status).toBe(429);
  });
});
