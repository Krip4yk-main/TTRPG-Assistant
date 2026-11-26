import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  WORKER_HEARTBEAT_KEY,
  WORKER_STALE_MS,
  writeWorkerHeartbeat,
} from '../../src/http/health.js';
import { startWorker } from '../../src/jobs/worker.js';
import { closeDeps, testDeps } from '../helpers.js';

const deps = await testDeps();
const { redis } = deps;

beforeEach(async () => {
  await redis.flushdb();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

describe('GET /api/health/live', () => {
  it('is 200 and does not set cookies', async () => {
    const res = await request(createApp(deps)).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('stays 200 when db and redis are broken', async () => {
    const bad = {
      ...deps,
      db: { execute: () => Promise.reject(new Error('x')) } as never,
      redis: { ping: () => Promise.reject(new Error('x')) } as never,
    };
    expect((await request(createApp(bad)).get('/api/health/live')).status).toBe(200);
  });
});

describe('writeWorkerHeartbeat', () => {
  it('writes the key with a TTL up to 10 minutes', async () => {
    await writeWorkerHeartbeat(redis);
    const ttl = await redis.ttl(WORKER_HEARTBEAT_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('does not throw when redis fails', async () => {
    const broken = { set: () => Promise.reject(new Error('down')) } as never;
    await expect(writeWorkerHeartbeat(broken)).resolves.toBeUndefined();
  });
});

describe('worker heartbeat', () => {
  it('startWorker writes the heartbeat on start', async () => {
    const worker = startWorker(deps, { pollMs: 60_000 });
    try {
      await vi.waitFor(async () => expect(await redis.exists(WORKER_HEARTBEAT_KEY)).toBe(1));
    } finally {
      await worker.stop();
    }
  });
});

describe('GET /api/health', () => {
  it('is 200 with a fresh heartbeat, without cookies or session', async () => {
    await writeWorkerHeartbeat(redis);
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: 'ok', redis: 'ok', worker: 'ok' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is 503 worker=stale without a heartbeat', async () => {
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'ok', redis: 'ok', worker: 'stale' });
  });

  it('is 503 worker=stale with a heartbeat older than 5 minutes', async () => {
    await redis.set(WORKER_HEARTBEAT_KEY, String(Date.now() - WORKER_STALE_MS - 1000), 'EX', 600);
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.worker).toBe('stale');
  });

  it('is 503 redis=down when redis throws, without leaking the error', async () => {
    const bad = {
      ...deps,
      redis: {
        ping: () => Promise.reject(new Error('secret-redis-url')),
        get: () => Promise.reject(new Error('secret-redis-url')),
      } as never,
    };
    const res = await request(createApp(bad)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'ok', redis: 'down', worker: 'down' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('is 503 db=down when the db throws', async () => {
    await writeWorkerHeartbeat(redis);
    const bad = { ...deps, db: { execute: () => Promise.reject(new Error('boom')) } as never };
    const res = await request(createApp(bad)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'down', redis: 'ok', worker: 'ok' });
  });

  it('times out a hanging check in about 1 second', async () => {
    await writeWorkerHeartbeat(redis);
    const hang = new Promise<never>(() => {});
    const bad = { ...deps, db: { execute: () => hang } as never };
    const started = Date.now();
    const res = await request(createApp(bad)).get('/api/health');
    const took = Date.now() - started;
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(2500);
  });
});
