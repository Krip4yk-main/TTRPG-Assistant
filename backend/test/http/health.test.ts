import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import {
  WORKER_HEARTBEAT_KEY,
  WORKER_PROGRESS_KEY,
  WORKER_STALE_MS,
  writeWorkerHeartbeat,
  writeWorkerProgress,
} from '../../src/jobs/liveness.js';
import { enqueue } from '../../src/jobs/queue.js';
import { registerHandler, resetRegistry } from '../../src/jobs/registry.js';
import { runDueJobs, startWorker } from '../../src/jobs/worker.js';
import { jobs } from '../../src/db/schema/index.js';
import { closeDeps, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;

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

describe('writeWorkerHeartbeat / writeWorkerProgress', () => {
  it('write their keys with a TTL up to 10 minutes', async () => {
    await writeWorkerHeartbeat(redis);
    await writeWorkerProgress(redis);
    for (const key of [WORKER_HEARTBEAT_KEY, WORKER_PROGRESS_KEY]) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    }
  });

  it('do not throw when redis fails', async () => {
    const broken = { set: () => Promise.reject(new Error('down')) } as never;
    await expect(writeWorkerHeartbeat(broken)).resolves.toBeUndefined();
    await expect(writeWorkerProgress(broken)).resolves.toBeUndefined();
  });
});

describe('worker liveness stamps', () => {
  afterEach(() => resetRegistry());

  it('startWorker writes the heartbeat and the loop progress on start', async () => {
    const worker = startWorker(deps, { pollMs: 60_000 });
    try {
      await vi.waitFor(async () => {
        expect(await redis.exists(WORKER_HEARTBEAT_KEY)).toBe(1);
        expect(await redis.exists(WORKER_PROGRESS_KEY)).toBe(1);
      });
    } finally {
      await worker.stop();
    }
  });

  it('runDueJobs stamps the progress before each job', async () => {
    const seen: (string | null)[] = [];
    registerHandler('t.progress', async () => {
      seen.push(await redis.get(WORKER_PROGRESS_KEY));
      await redis.del(WORKER_PROGRESS_KEY);
    });
    const runAt = new Date(Date.now() - 1000);
    await enqueue(deps, { type: 't.progress', payload: { n: 1 }, runAt });
    await enqueue(deps, { type: 't.progress', payload: { n: 2 }, runAt });
    try {
      expect(await runDueJobs(deps)).toBe(2);
    } finally {
      await db.delete(jobs).where(eq(jobs.type, 't.progress'));
    }
    expect(seen).toHaveLength(2);
    for (const v of seen) expect(Number(v)).toBeGreaterThan(Date.now() - 60_000);
    // Після останньої задачі — теж штамп.
    expect(await redis.exists(WORKER_PROGRESS_KEY)).toBe(1);
  });
});

describe('GET /api/health', () => {
  it('is 200 with fresh loop progress, without cookies or session', async () => {
    await writeWorkerHeartbeat(redis);
    await writeWorkerProgress(redis);
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: 'ok', redis: 'ok', worker: 'ok' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('is 503 worker=stale without loop progress', async () => {
    await writeWorkerHeartbeat(redis);
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'ok', redis: 'ok', worker: 'stale' });
  });

  it('is 503 worker=stale when the process is alive but the job loop is stuck', async () => {
    // Heartbeat свіжий (процес живий), а цикл задач не просувався понад 5 хв.
    await writeWorkerHeartbeat(redis);
    await redis.set(WORKER_PROGRESS_KEY, String(Date.now() - WORKER_STALE_MS - 1000), 'EX', 600);
    const res = await request(createApp(deps)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'ok', redis: 'ok', worker: 'stale' });
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
    await writeWorkerProgress(redis);
    const bad = { ...deps, db: { execute: () => Promise.reject(new Error('boom')) } as never };
    const res = await request(createApp(bad)).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: 'down', redis: 'ok', worker: 'ok' });
  });

  it('times out a hanging check in about 1 second', async () => {
    await writeWorkerProgress(redis);
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
