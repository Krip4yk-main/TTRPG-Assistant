import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { jobs } from '../../src/db/schema/index.js';
import { enqueue } from '../../src/jobs/queue.js';
import {
  ensureRecurring,
  nextRunAt,
  registerHandler,
  registerRecurring,
  resetRegistry,
} from '../../src/jobs/registry.js';
import {
  LOCK_MS,
  MAX_ATTEMPTS,
  backoffMs,
  runDueJobs,
  startWorker,
} from '../../src/jobs/worker.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

const T0 = new Date('2030-03-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  resetRegistry();
  await resetDb(db);
});
afterEach(() => resetRegistry());
afterAll(async () => {
  await closeDeps(deps);
});

async function jobRow(id: number) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row!;
}

describe('runDueJobs', () => {
  it('виконує задачу, що настала, з payload і позначає done', async () => {
    const seen: unknown[] = [];
    registerHandler('t.ok', async (_deps, payload, job) => {
      seen.push({ payload, attempts: job.attempts });
    });
    const { id } = (await enqueue(deps, { type: 't.ok', payload: { a: 1 }, runAt: T0 }))!;
    expect(await runDueJobs(deps, at(-1))).toBe(0);
    expect(seen).toHaveLength(0);
    expect(await runDueJobs(deps, T0)).toBe(1);
    expect(seen).toEqual([{ payload: { a: 1 }, attempts: 1 }]);
    const row = await jobRow(id);
    expect(row.status).toBe('done');
    expect(row.lockedUntil).toBeNull();
    expect(await runDueJobs(deps, at(60_000))).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('два паралельні runDueJobs виконують кожну задачу рівно один раз', async () => {
    const counts = new Map<number, number>();
    registerHandler('t.once', async (_d, payload) => {
      const n = (payload as { n: number }).n;
      counts.set(n, (counts.get(n) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 30));
    });
    for (let n = 0; n < 6; n++) await enqueue(deps, { type: 't.once', payload: { n }, runAt: T0 });
    const [a, b] = await Promise.all([runDueJobs(deps, T0), runDueJobs(deps, T0)]);
    expect(a + b).toBe(6);
    expect([...counts.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts.size).toBe(6);
    const rows = await db.select().from(jobs);
    expect(rows.every((r) => r.status === 'done')).toBe(true);
  });

  it('SKIP LOCKED: заблоковані іншою транзакцією рядки пропускаються без очікування', async () => {
    const ran: number[] = [];
    registerHandler('t.skip', async (_d, payload) => {
      ran.push((payload as { n: number }).n);
    });
    const ids: number[] = [];
    for (let n = 0; n < 6; n++) {
      ids.push((await enqueue(deps, { type: 't.skip', payload: { n }, runAt: T0 }))!.id);
    }
    // Інший «воркер» тримає відкриту транзакцію з локом на перших трьох рядках.
    await db.transaction(
      async (tx) => {
        await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(inArray(jobs.id, ids.slice(0, 3)))
          .for('update');
        const started = Date.now();
        expect(await runDueJobs(deps, T0, { limit: 3 })).toBe(3);
        // Не чекав на лок (innodb_lock_wait_timeout — 50 с).
        expect(Date.now() - started).toBeLessThan(5_000);
        // READ COMMITTED: у REPEATABLE READ на крихітній таблиці повний скан заблокував би всі рядки.
      },
      { isolationLevel: 'read committed' },
    );
    expect(ran.sort()).toEqual([3, 4, 5]);
    expect(await runDueJobs(deps, T0)).toBe(3);
    expect(ran.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('limit обмежує кількість задач за прогін', async () => {
    registerHandler('t.lim', async () => {});
    for (let i = 0; i < 3; i++) await enqueue(deps, { type: 't.lim', runAt: T0 });
    expect(await runDueJobs(deps, T0, { limit: 2 })).toBe(2);
    expect(await runDueJobs(deps, T0, { limit: 2 })).toBe(1);
  });

  it('помилка → повтор з експоненційною затримкою, після 5 спроб — failed', async () => {
    let calls = 0;
    registerHandler('t.fail', async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    });
    const { id } = (await enqueue(deps, { type: 't.fail', runAt: T0 }))!;
    let now = T0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await runDueJobs(deps, now)).toBe(1);
      const row = await jobRow(id);
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toContain(`boom ${attempt}`);
      expect(row.lockedUntil).toBeNull();
      const delay = backoffMs(attempt);
      expect(delay).toBe(30_000 * 2 ** (attempt - 1));
      expect(row.runAt.getTime()).toBe(now.getTime() + delay);
      // До настання затримки — не виконується.
      expect(await runDueJobs(deps, new Date(now.getTime() + delay - 1))).toBe(0);
      now = new Date(now.getTime() + delay);
    }
    expect(await runDueJobs(deps, now)).toBe(1);
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.lastError).toContain(`boom ${MAX_ATTEMPTS}`);
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(await runDueJobs(deps, at(365 * 86_400_000))).toBe(0);
  });

  it('невідомий тип → failed без повторів', async () => {
    const { id } = (await enqueue(deps, { type: 't.unknown', runAt: T0 }))!;
    expect(await runDueJobs(deps, T0)).toBe(1);
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/handler/i);
  });

  it('задача «впалого» воркера з простроченим локом захоплюється знову', async () => {
    let calls = 0;
    registerHandler('t.crash', async () => {
      calls++;
    });
    const { id } = (await enqueue(deps, { type: 't.crash', runAt: T0 }))!;
    // Імітуємо воркер, що захопив задачу й упав.
    await db
      .update(jobs)
      .set({ status: 'running', attempts: 1, lockedUntil: at(LOCK_MS) })
      .where(eq(jobs.id, id));
    expect(await runDueJobs(deps, at(LOCK_MS - 1))).toBe(0);
    expect(calls).toBe(0);
    expect(await runDueJobs(deps, at(LOCK_MS + 1))).toBe(1);
    expect(calls).toBe(1);
    const row = await jobRow(id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
  });

  it('прострочений лок після останньої спроби → failed без запуску', async () => {
    let calls = 0;
    registerHandler('t.crash5', async () => {
      calls++;
    });
    const { id } = (await enqueue(deps, { type: 't.crash5', runAt: T0 }))!;
    await db
      .update(jobs)
      .set({ status: 'running', attempts: MAX_ATTEMPTS, lockedUntil: T0 })
      .where(eq(jobs.id, id));
    await runDueJobs(deps, at(1));
    expect(calls).toBe(0);
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/lock/i);
  });

  it('прострочений лок після останньої спроби доповнює lastError, а не перезаписує', async () => {
    registerHandler('t.crash5e', async () => {});
    const { id } = (await enqueue(deps, { type: 't.crash5e', runAt: T0 }))!;
    await db
      .update(jobs)
      .set({ status: 'running', attempts: MAX_ATTEMPTS, lockedUntil: T0, lastError: 'boom 4' })
      .where(eq(jobs.id, id));
    await runDueJobs(deps, at(1));
    const row = await jobRow(id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('boom 4');
    expect(row.lastError).toMatch(/lock expired/);
  });

  it('shouldStop між задачами: незапущені захоплені задачі повертаються в pending', async () => {
    let calls = 0;
    let stop = false;
    registerHandler('t.halt', async () => {
      calls++;
      stop = true;
    });
    const a = (await enqueue(deps, { type: 't.halt', runAt: T0 }))!.id;
    const b = (await enqueue(deps, { type: 't.halt', runAt: at(1) }))!.id;
    expect(await runDueJobs(deps, at(1), { shouldStop: () => stop })).toBe(2);
    expect(calls).toBe(1);
    expect((await jobRow(a)).status).toBe('done');
    expect(await jobRow(b)).toMatchObject({ status: 'pending', attempts: 0, lockedUntil: null });
  });

  it('застарілий виконавець (лок перехоплено) не перезаписує результат', async () => {
    let release!: () => void;
    let calls = 0;
    registerHandler('t.slow', async () => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r));
      else throw new Error('second run failed');
    });
    const { id } = (await enqueue(deps, { type: 't.slow', runAt: T0 }))!;
    const first = runDueJobs(deps, T0);
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    // Лок прострочено — інший воркер перехоплює й отримує помилку → pending з повтором.
    await runDueJobs(deps, at(LOCK_MS + 1));
    const mid = await jobRow(id);
    expect(mid.status).toBe('pending');
    expect(mid.attempts).toBe(2);
    release();
    await first;
    const row = await jobRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(2);
  });
});

describe('recurring', () => {
  it('nextRunAt: everyMs вирівнюється за епохою, dailyAtUtc — наступне HH:MM', () => {
    expect(nextRunAt({ everyMs: 10_000 }, new Date('2030-03-01T12:00:03Z')).toISOString()).toBe(
      '2030-03-01T12:00:10.000Z',
    );
    expect(nextRunAt({ everyMs: 10_000 }, new Date('2030-03-01T12:00:10Z')).toISOString()).toBe(
      '2030-03-01T12:00:20.000Z',
    );
    expect(nextRunAt({ dailyAtUtc: '03:00' }, new Date('2030-03-01T02:59:59Z')).toISOString()).toBe(
      '2030-03-01T03:00:00.000Z',
    );
    expect(nextRunAt({ dailyAtUtc: '03:00' }, new Date('2030-03-01T03:00:00Z')).toISOString()).toBe(
      '2030-03-02T03:00:00.000Z',
    );
    expect(() => registerRecurring('t.bad', { dailyAtUtc: '25:00' })).toThrow();
  });

  it('ensureRecurring ставить перший запуск один раз (і паралельно)', async () => {
    registerHandler('t.rec', async () => {});
    registerRecurring('t.rec', { everyMs: 60_000 });
    await Promise.all([ensureRecurring(deps, T0), ensureRecurring(deps, T0)]);
    await ensureRecurring(deps, at(1000));
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uniqueKey).toBe('t.rec@2030-03-01T12:01:00.000Z');
    expect(rows[0]!.runAt.toISOString()).toBe('2030-03-01T12:01:00.000Z');
  });

  it('після виконання ставить наступний запуск; повторні й паралельні прогони не дублюють', async () => {
    let calls = 0;
    registerHandler('t.tick', async () => {
      calls++;
    });
    registerRecurring('t.tick', { everyMs: 60_000 });
    await ensureRecurring(deps, T0);
    const slot1 = at(60_000);
    await Promise.all([runDueJobs(deps, slot1), runDueJobs(deps, slot1)]);
    await runDueJobs(deps, slot1);
    expect(calls).toBe(1);
    const pending = await db.select().from(jobs).where(eq(jobs.status, 'pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.uniqueKey).toBe('t.tick@2030-03-01T12:02:00.000Z');
    // ensureRecurring після рестарту не додає ще одну.
    await ensureRecurring(deps, slot1);
    expect(await db.select().from(jobs).where(eq(jobs.status, 'pending'))).toHaveLength(1);
    // Наступний слот.
    await Promise.all([runDueJobs(deps, at(120_000)), runDueJobs(deps, at(120_000))]);
    expect(calls).toBe(2);
    expect(await db.select().from(jobs).where(eq(jobs.status, 'pending'))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.status, 'done'))).toHaveLength(2);
  });

  it('після простою наступний запуск — у майбутньому, без надолуження', async () => {
    registerHandler('t.late', async () => {});
    registerRecurring('t.late', { everyMs: 60_000 });
    await ensureRecurring(deps, T0);
    await runDueJobs(deps, at(10 * 60_000 + 5_000));
    const [p] = await db.select().from(jobs).where(eq(jobs.status, 'pending'));
    expect(p!.runAt.toISOString()).toBe('2030-03-01T12:11:00.000Z');
  });

  it('проміжна помилка не перепланує, остаточна — перепланує', async () => {
    registerHandler('t.rfail', async () => {
      throw new Error('nope');
    });
    registerRecurring('t.rfail', { dailyAtUtc: '03:00' });
    await ensureRecurring(deps, T0);
    let now = new Date('2030-03-02T03:00:00Z');
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await runDueJobs(deps, now);
      expect(await db.select().from(jobs)).toHaveLength(1);
      now = new Date(now.getTime() + backoffMs(attempt));
    }
    await runDueJobs(deps, now);
    const rows = await db.select().from(jobs);
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'pending']);
    const next = rows.find((r) => r.status === 'pending')!;
    expect(next.uniqueKey).toBe('t.rfail@2030-03-03T03:00:00.000Z');
  });
});

describe('startWorker', () => {
  it('самовідновлення: періодична задача без наступника отримує новий запуск', async () => {
    registerHandler('t.heal', async () => {});
    registerRecurring('t.heal', { everyMs: 3_600_000 });
    // Ланцюжок обірвався: є лише виконаний запуск, наступного немає.
    await db.insert(jobs).values({ type: 't.heal', runAt: T0, status: 'done', attempts: 1 });
    const worker = startWorker(deps, { pollMs: 10 });
    try {
      for (let i = 0; i < 200; i++) {
        const p = await db.select().from(jobs).where(eq(jobs.status, 'pending'));
        if (p.length) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      await worker.stop();
    }
    const pending = await db.select().from(jobs).where(eq(jobs.status, 'pending'));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe('t.heal');
    expect(pending[0]!.uniqueKey).toMatch(/^t\.heal@/);
    expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('stop() повертає незапущені задачі пакета в pending', async () => {
    let release!: () => void;
    let started = 0;
    registerHandler('t.batch', async () => {
      started++;
      await new Promise<void>((r) => (release = r));
    });
    const first = (await enqueue(deps, { type: 't.batch', runAt: new Date(Date.now() - 1000) }))!;
    const second = (await enqueue(deps, { type: 't.batch', runAt: new Date(Date.now() - 500) }))!;
    const worker = startWorker(deps, { pollMs: 10 });
    while (started === 0) await new Promise((r) => setTimeout(r, 5));
    const stopping = worker.stop();
    release();
    await stopping;
    expect(started).toBe(1);
    expect((await jobRow(first.id)).status).toBe('done');
    expect(await jobRow(second.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      lockedUntil: null,
    });
  });

  it('опитує чергу, stop() чекає завершення поточного прогону', async () => {
    let release!: () => void;
    let started = false;
    let finished = false;
    registerHandler('t.bg', async () => {
      started = true;
      await new Promise<void>((r) => (release = r));
      finished = true;
    });
    await enqueue(deps, { type: 't.bg' });
    const worker = startWorker(deps, { pollMs: 10 });
    while (!started) await new Promise((r) => setTimeout(r, 5));
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    const [row] = await db.select().from(jobs);
    expect(row!.status).toBe('done');
    // Після stop() нових прогонів немає.
    let ran = false;
    registerHandler('t.after', async () => {
      ran = true;
    });
    await enqueue(deps, { type: 't.after' });
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(false);
  });
});
