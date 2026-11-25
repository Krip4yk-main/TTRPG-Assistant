import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { jobs } from '../db/schema/index.js';
import { getHandler, getRecurring, scheduleNextRun, type JobRow } from './registry.js';

export const MAX_ATTEMPTS = 5;
/** Скільки задача вважається захопленою; після — її підхоплює інший воркер. */
export const LOCK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const ERROR_MAX_LEN = 4000;

/** Затримка перед повтором після спроби №`attempts` (з 1): 30 с · 2^(attempts-1). */
export const backoffMs = (attempts: number): number => BACKOFF_BASE_MS * 2 ** (attempts - 1);

const errorText = (err: unknown): string =>
  (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, ERROR_MAX_LEN);

/**
 * Захоплює задачі, що настали (або «впалі» — `running` з простроченим локом), короткою
 * транзакцією з `FOR UPDATE SKIP LOCKED` і виконує їх поза нею, по черзі.
 * `attempts` збільшується при захопленні й слугує токеном власника: завершення застарілого
 * виконавця (чий лок перехопили) нічого не змінює. Повертає кількість захоплених задач.
 */
export async function runDueJobs(
  deps: AppDeps,
  now: Date = new Date(),
  { limit = 10 }: { limit?: number } = {},
): Promise<number> {
  const lockedUntil = new Date(now.getTime() + LOCK_MS);
  const { claimed, exhausted } = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(jobs)
      .where(
        or(
          and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)),
          and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, now)),
        ),
      )
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    // «Впала» остання спроба — більше не запускаємо.
    const dead = rows.filter((r) => r.status === 'running' && r.attempts >= MAX_ATTEMPTS);
    const runnable = rows.filter((r) => !dead.includes(r));
    if (dead.length) {
      await tx
        .update(jobs)
        .set({ status: 'failed', lockedUntil: null, lastError: 'lock expired on last attempt' })
        .where(
          inArray(
            jobs.id,
            dead.map((r) => r.id),
          ),
        );
    }
    if (runnable.length) {
      await tx
        .update(jobs)
        .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, lockedUntil })
        .where(
          inArray(
            jobs.id,
            runnable.map((r) => r.id),
          ),
        );
    }
    return {
      claimed: runnable.map((r): JobRow => ({
        ...r,
        status: 'running',
        attempts: r.attempts + 1,
        lockedUntil,
      })),
      exhausted: dead,
    };
  });

  for (const job of exhausted) await rescheduleIfRecurring(deps, job, now);
  for (const job of claimed) await runOne(deps, job, now);
  return claimed.length + exhausted.length;
}

async function runOne(deps: AppDeps, job: JobRow, now: Date): Promise<void> {
  const owned = and(
    eq(jobs.id, job.id),
    eq(jobs.status, 'running'),
    eq(jobs.attempts, job.attempts),
  );
  const handler = getHandler(job.type);
  let error: unknown = null;
  if (!handler) {
    error = new Error(`no handler registered for job type "${job.type}"`);
  } else {
    try {
      await handler(deps, job.payload, job);
    } catch (err) {
      error = err ?? new Error('job failed');
    }
  }

  const terminal = error === null || !handler || job.attempts >= MAX_ATTEMPTS;
  const [res] = await deps.db
    .update(jobs)
    .set(
      error === null
        ? { status: 'done', lockedUntil: null, lastError: null }
        : terminal
          ? { status: 'failed', lockedUntil: null, lastError: errorText(error) }
          : {
              status: 'pending',
              lockedUntil: null,
              lastError: errorText(error),
              runAt: new Date(now.getTime() + backoffMs(job.attempts)),
            },
    )
    .where(owned);
  // Застарілий виконавець (лок перехоплено) нічого не змінює й не перепланує.
  if (res.affectedRows === 0) return;
  if (error !== null && terminal) console.error(`job ${job.id} (${job.type}) failed`, error);
  if (terminal) await rescheduleIfRecurring(deps, job, now);
}

async function rescheduleIfRecurring(deps: AppDeps, job: JobRow, now: Date): Promise<void> {
  if (!getRecurring(job.type)) return;
  // Не раніше за слот поточного запуску: наступний слот завжди строго пізніший.
  const after = job.runAt.getTime() > now.getTime() ? job.runAt : now;
  await scheduleNextRun(deps, job.type, after);
}

export type Worker = { stop(): Promise<void> };

/** Фоновий цикл опитування черги. `stop()` чекає завершення поточного прогону. */
export function startWorker(deps: AppDeps, { pollMs = 5000 }: { pollMs?: number } = {}): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped) return;
    current = (async () => {
      try {
        // Є ще задачі — одразу наступний прогін, без очікування.
        while (!stopped && (await runDueJobs(deps)) > 0);
      } catch (err) {
        console.error('job worker error', err);
      }
    })().finally(() => {
      if (!stopped) timer = setTimeout(tick, pollMs);
    });
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
