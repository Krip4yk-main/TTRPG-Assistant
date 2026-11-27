import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { jobs } from '../../src/db/schema/index.js';
import { enqueue } from '../../src/jobs/queue.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { TEST_NOW } from '../test-now.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

async function dbNow(d: Pick<Db, 'execute'> = db): Promise<number> {
  // drizzle віддає datetime із сирого SQL рядком 'YYYY-MM-DD hh:mm:ss.fff' (UTC-сесія).
  const [rows] = (await d.execute(sql`SELECT NOW(3) AS n`)) as unknown as [{ n: string }[]];
  return Date.parse(`${rows[0]!.n.replace(' ', 'T')}Z`);
}

/** `enqueue` без `runAt` бере «зараз» у JS, а `created_at` ставить MySQL (`CURRENT_TIMESTAMP`). */
async function enqueueNow(): Promise<{ runAt: number; createdAt: number }> {
  const res = await enqueue(deps, { type: 't.clock' });
  const [row] = await db.select().from(jobs).where(eq(jobs.id, res!.id));
  return { runAt: row!.runAt.getTime(), createdAt: row!.createdAt.getTime() };
}

describe('тестовий годинник', () => {
  it('за замовчуванням «зараз» у JS і в MySQL — TEST_NOW', async () => {
    expect(Date.now() - TEST_NOW).toBeGreaterThanOrEqual(0);
    expect(Date.now() - TEST_NOW).toBeLessThan(10 * 60_000);
    expect(Math.abs((await dbNow()) - Date.now())).toBeLessThan(1000);
    const { runAt, createdAt } = await enqueueNow();
    expect(Math.abs(runAt - Date.now())).toBeLessThan(1000);
    // created_at — datetime без дробу: MySQL округлює до секунди.
    expect(Math.abs(createdAt - runAt)).toBeLessThanOrEqual(1000);
  });

  it('час, підмінений тестом, бачить і MySQL', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-07T17:40:00.000Z') });
    expect(await dbNow()).toBe(Date.parse('2030-03-07T17:40:00.000Z'));
    vi.setSystemTime(new Date('2031-01-01T00:00:05.250Z'));
    expect(await dbNow()).toBe(Date.parse('2031-01-01T00:00:05.250Z'));
    const { createdAt } = await enqueueNow();
    expect(createdAt).toBe(Date.parse('2031-01-01T00:00:05.000Z'));
  });

  it('у транзакції час БД фіксується на її початку', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2030-03-07T17:40:00.000Z') });
    await db.transaction(async (tx) => {
      vi.setSystemTime(new Date('2030-03-07T18:00:00.000Z'));
      expect(await dbNow(tx)).toBe(Date.parse('2030-03-07T17:40:00.000Z'));
    });
    expect(await dbNow()).toBe(Date.parse('2030-03-07T18:00:00.000Z'));
  });

  it('Date.now() ≤ 0 — запит не виконується (SET TIMESTAMP = 0 повернув би реальний час)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    // drizzle загортає помилку драйвера: наша — у `cause`.
    await expect(dbNow()).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/^syncDbClock/) }),
    });
    vi.setSystemTime(new Date('2030-03-07T17:40:00.000Z'));
    expect(await dbNow()).toBe(Date.parse('2030-03-07T17:40:00.000Z'));
  });

  it('після тесту, що змінив час, знову TEST_NOW', async () => {
    expect(Date.now() - TEST_NOW).toBeLessThan(10 * 60_000);
    expect(Math.abs((await dbNow()) - Date.now())).toBeLessThan(1000);
  });
});

describe('реальний годинник', () => {
  it('enqueue без runAt і CURRENT_TIMESTAMP у MySQL беруть справжній час', async () => {
    vi.useRealTimers();
    const before = Date.now();
    const { runAt, createdAt } = await enqueueNow();
    const db1 = await dbNow();
    const after = Date.now();
    expect(Math.abs(before - vi.getRealSystemTime())).toBeLessThan(1000);
    // Справжній час: далеко від TEST_NOW, який лишився в минулому.
    expect(before - TEST_NOW).toBeGreaterThan(60 * 60_000);
    expect(runAt).toBeGreaterThanOrEqual(before);
    expect(runAt).toBeLessThanOrEqual(after);
    expect(db1).toBeGreaterThanOrEqual(before);
    expect(db1).toBeLessThanOrEqual(after);
    // created_at округлено до секунди.
    expect(createdAt).toBeGreaterThanOrEqual(before - 1000);
    expect(createdAt).toBeLessThanOrEqual(after + 1000);
  });
});
