import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema/index.js';
import {
  ensureRecurring,
  getHandler,
  getRecurring,
  scheduleNextRun,
  type JobRow,
} from './registry.js';

export const MAX_ATTEMPTS = 5;
/** Скільки задача вважається захопленою; після — її підхоплює інший воркер. */
export const LOCK_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 30_000;
const ERROR_MAX_LEN = 4000;
const ENSURE_RECURRING_EVERY_MS = 60_000;

/** Затримка перед повтором після спроби №`attempts` (з 1): 30 с · 2^(attempts-1). */
export const backoffMs = (attempts: number): number => BACKOFF_BASE_MS * 2 ** (attempts - 1);

const errorText = (err: unknown): string =>
  (err instanceof Error ? (err.stack ?? err.message) : String(err)).slice(0, ERROR_MAX_LEN);

/** Рядок усе ще належить цьому запуску (лок не перехоплено). */
const owned = (job: JobRow) =>
  and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.attempts, job.attempts));

export type RunDueJobsOptions = {
  limit?: number;
  /** Перевіряється між задачами: true → незапущені захоплені задачі повертаються в pending. */
  shouldStop?: () => boolean;
};

/**
 * Захоплює задачі, що настали (або «впалі» — `running` з простроченим локом), короткою
 * транзакцією (READ COMMITTED, `FOR UPDATE SKIP LOCKED`) і виконує їх поза нею, по черзі.
 * `attempts` збільшується при захопленні й слугує токеном власника: завершення застарілого
 * виконавця (чий лок перехопили) нічого не змінює. Помилка однієї задачі не зупиняє пакет.
 * `now` — для тестів; без нього кожна задача бере свіжий час (лок, затримка повтору).
 * Повертає кількість захоплених задач.
 */
export async function runDueJobs(
  deps: AppDeps,
  now?: Date,
  { limit = 10, shouldStop }: RunDueJobsOptions = {},
): Promise<number> {
  const clock = (): Date => now ?? new Date();
  const claimAt = clock();
  const lockedUntil = new Date(claimAt.getTime() + LOCK_MS);
  const { claimed, exhausted } = await deps.db.transaction(
    async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(
          or(
            and(eq(jobs.status, 'pending'), lte(jobs.runAt, claimAt)),
            and(eq(jobs.status, 'running'), lt(jobs.lockedUntil, claimAt)),
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
          .set({
            status: 'failed',
            lockedUntil: null,
            lastError: sql`CONCAT_WS('\n', ${jobs.lastError}, 'lock expired on last attempt')`,
          })
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
    },
    { isolationLevel: 'read committed' },
  );

  for (const job of exhausted) {
    try {
      await rescheduleIfRecurring(deps.db, job, clock());
    } catch (err) {
      console.error(`job ${job.id} (${job.type}): reschedule failed`, err);
    }
  }
  for (let i = 0; i < claimed.length; i++) {
    const job = claimed[i]!;
    if (shouldStop?.()) {
      await releaseJobs(deps.db, claimed.slice(i));
      break;
    }
    try {
      await runOne(deps, job, clock);
    } catch (err) {
      // Збій БД під час фіналізації: задачу підхопить інший прогін після спливу локу.
      console.error(`job ${job.id} (${job.type}): worker error`, err);
    }
  }
  return claimed.length + exhausted.length;
}

/** Повертає захоплені, але не запущені задачі в pending (спроба не рахується). */
async function releaseJobs(db: Db, list: JobRow[]): Promise<void> {
  for (const job of list) {
    try {
      await db
        .update(jobs)
        .set({ status: 'pending', attempts: job.attempts - 1, lockedUntil: null })
        .where(owned(job));
    } catch (err) {
      console.error(`job ${job.id} (${job.type}): release failed`, err);
    }
  }
}

async function runOne(deps: AppDeps, job: JobRow, clock: () => Date): Promise<void> {
  // Свіжий лок перед запуском: задача могла чекати в пакеті за повільними сусідами.
  const lockedUntil = new Date(clock().getTime() + LOCK_MS);
  const [lock] = await deps.db.update(jobs).set({ lockedUntil }).where(owned(job));
  if (lock.affectedRows === 0) return; // лок уже перехопили
  const current: JobRow = { ...job, lockedUntil };

  const handler = getHandler(current.type);
  let error: unknown = null;
  if (!handler) {
    // Невідомий тип — одразу failed: виходимо з того, що всі процеси мають однаковий набір
    // обробників (один екземпляр / однакова версія). При поетапному розгортанні старий процес
    // міг би «з'їсти» задачу нового типу — тоді реєстрацію треба розгорнути раніше за постановку.
    error = new Error(`no handler registered for job type "${current.type}"`);
  } else {
    try {
      await handler(deps, current.payload, current);
    } catch (err) {
      error = err ?? new Error('job failed');
    }
  }

  const finishedAt = clock();
  const terminal = error === null || !handler || current.attempts >= MAX_ATTEMPTS;
  // Фіналізація й постановка наступного слоту — атомарно.
  const applied = await deps.db.transaction(async (tx) => {
    const [res] = await tx
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
                runAt: new Date(finishedAt.getTime() + backoffMs(current.attempts)),
              },
      )
      .where(owned(current));
    // Застарілий виконавець (лок перехоплено) нічого не змінює й не перепланує.
    if (res.affectedRows === 0) return false;
    if (terminal) await rescheduleIfRecurring(tx, current, finishedAt);
    return true;
  });
  if (applied && error !== null && terminal) {
    console.error(`job ${current.id} (${current.type}) failed`, error);
  }
}

async function rescheduleIfRecurring(
  db: Pick<Db, 'insert'>,
  job: JobRow,
  now: Date,
): Promise<void> {
  if (!getRecurring(job.type)) return;
  // Не раніше за слот поточного запуску: наступний слот завжди строго пізніший.
  const after = job.runAt.getTime() > now.getTime() ? job.runAt : now;
  await scheduleNextRun({ db }, job.type, after);
}

export type Worker = { stop(): Promise<void> };

export type WorkerOptions = {
  pollMs?: number;
  /** Як часто перевіряти й відновлювати ланцюжки періодичних задач. */
  ensureRecurringEveryMs?: number;
};

/**
 * Фоновий цикл опитування черги. На старті й далі раз на `ensureRecurringEveryMs` викликає
 * `ensureRecurring` (поки БД недоступна — повтор кожні `pollMs`). `stop()` чекає завершення
 * поточної задачі; решту захопленого пакета повертає в pending.
 */
export function startWorker(
  deps: AppDeps,
  { pollMs = 5000, ensureRecurringEveryMs = ENSURE_RECURRING_EVERY_MS }: WorkerOptions = {},
): Worker {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  let lastEnsureAt = -Infinity;
  const shouldStop = (): boolean => stopped;

  const tick = (): void => {
    if (stopped) return;
    current = (async () => {
      try {
        if (Date.now() - lastEnsureAt >= ensureRecurringEveryMs) {
          await ensureRecurring(deps);
          lastEnsureAt = Date.now();
        }
        // Є ще задачі — одразу наступний прогін, без очікування.
        while (!stopped && (await runDueJobs(deps, undefined, { shouldStop })) > 0);
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
