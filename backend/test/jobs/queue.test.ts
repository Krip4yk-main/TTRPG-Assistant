import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '../../src/db/schema/index.js';
import { enqueue, purgeFinishedJobs } from '../../src/jobs/queue.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

describe('enqueue', () => {
  it('створює pending-задачу з payload і runAt', async () => {
    const runAt = new Date('2030-01-01T10:00:00.123Z');
    const res = await enqueue(deps, { type: 't.a', payload: { x: 1 }, runAt });
    expect(res).not.toBeNull();
    const [row] = await db.select().from(jobs).where(eq(jobs.id, res!.id));
    expect(row).toMatchObject({
      type: 't.a',
      payload: { x: 1 },
      status: 'pending',
      attempts: 0,
      lastError: null,
      lockedUntil: null,
      uniqueKey: null,
    });
    expect(row!.runAt.toISOString()).toBe('2030-01-01T10:00:00.123Z');
  });

  it('без runAt — на зараз', async () => {
    const before = Date.now();
    const res = await enqueue(deps, { type: 't.now' });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, res!.id));
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1);
    expect(row!.payload).toBeNull();
  });

  it('дубль uniqueKey — no-op (null), рядок один', async () => {
    const a = await enqueue(deps, { type: 't.u', uniqueKey: 'k1', payload: { n: 1 } });
    const b = await enqueue(deps, { type: 't.u', uniqueKey: 'k1', payload: { n: 2 } });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ n: 1 });
  });

  it('паралельні дублі uniqueKey — один рядок', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => enqueue(deps, { type: 't.p', uniqueKey: 'same' })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('задачі без uniqueKey не дедуплікуються', async () => {
    await enqueue(deps, { type: 't.n' });
    await enqueue(deps, { type: 't.n' });
    expect(await db.select().from(jobs)).toHaveLength(2);
  });
});

describe('purgeFinishedJobs', () => {
  it('видаляє старі done/failed, лишає свіжі й pending', async () => {
    const now = new Date('2030-01-10T00:00:00Z');
    const old = new Date('2030-01-01T00:00:00Z');
    await db.insert(jobs).values([
      { type: 'a', runAt: old, status: 'done', updatedAt: old },
      { type: 'b', runAt: old, status: 'failed', updatedAt: old },
      { type: 'c', runAt: old, status: 'pending', updatedAt: old },
      { type: 'd', runAt: now, status: 'done', updatedAt: now },
    ]);
    await purgeFinishedJobs(deps, now, {
      doneOlderThanMs: 86_400_000,
      failedOlderThanMs: 86_400_000,
    });
    const left = (await db.select({ type: jobs.type }).from(jobs)).map((r) => r.type).sort();
    expect(left).toEqual(['c', 'd']);
  });

  it('за замовчуванням: done > 1 доби і failed > 30 діб видаляються, failed < 30 діб лишається', async () => {
    const DAY = 86_400_000;
    const now = new Date('2030-03-01T00:00:00Z');
    const ago = (n: number) => new Date(now.getTime() - n * DAY);
    await db.insert(jobs).values([
      { type: 'old-done', runAt: ago(5), status: 'done', updatedAt: ago(5) },
      { type: 'fresh-done', runAt: ago(0), status: 'done', updatedAt: ago(0) },
      { type: 'old-failed', runAt: ago(40), status: 'failed', updatedAt: ago(40) },
      { type: 'new-failed', runAt: ago(10), status: 'failed', updatedAt: ago(10) },
      { type: 'old-pending', runAt: ago(40), status: 'pending', updatedAt: ago(40) },
    ]);
    expect(await purgeFinishedJobs(deps, now)).toBe(2);
    const left = (await db.select({ type: jobs.type }).from(jobs)).map((r) => r.type).sort();
    expect(left).toEqual(['fresh-done', 'new-failed', 'old-pending']);
  });

  it('видаляє пачками: backlog більший за одну пачку чиститься повністю', async () => {
    const now = new Date('2030-03-01T00:00:00Z');
    const old = new Date('2030-02-01T00:00:00Z');
    const rows = Array.from({ length: 5001 }, () => ({
      type: 'x',
      runAt: old,
      status: 'done' as const,
      updatedAt: old,
    }));
    await db.insert(jobs).values(rows);
    expect(await purgeFinishedJobs(deps, now)).toBe(5001);
  });
});
