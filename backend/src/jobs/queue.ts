import { and, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema/index.js';
import { isDuplicateKey } from '../db/errors.js';

export type EnqueueOptions = {
  type: string;
  payload?: unknown;
  /** За замовчуванням — зараз. */
  runAt?: Date;
  /**
   * Дедуплікація: задача з таким ключем уже є (у будь-якому статусі) → no-op. Ключ унікальний
   * лише доки рядок живе: `purgeFinishedJobs` видаляє завершені задачі, тож довготривала
   * дедуплікація (сповіщення, нагадування) — на доменних UNIQUE, а не на `unique_key`.
   */
  uniqueKey?: string;
};

/**
 * Ставить задачу в чергу. Приймає й транзакцію (`{ db: tx }`): дубль ключа в InnoDB
 * відкочує лише інструкцію, не всю транзакцію. Повертає `null`, якщо `uniqueKey` уже зайнятий.
 */
export async function enqueue(
  deps: { db: Pick<Db, 'insert'> },
  opts: EnqueueOptions,
): Promise<{ id: number } | null> {
  try {
    const [res] = await deps.db
      .insert(jobs)
      .values({
        type: opts.type,
        payload: opts.payload ?? null,
        runAt: opts.runAt ?? new Date(),
        uniqueKey: opts.uniqueKey ?? null,
      })
      .$returningId();
    return { id: res!.id };
  } catch (err) {
    if (opts.uniqueKey !== undefined && isDuplicateKey(err)) return null;
    throw err;
  }
}

const PURGE_FINISHED_BATCH = 5000;

/** Видаляє завершені задачі, що востаннє змінювалися раніше за поріг (за `updated_at`). */
export async function purgeFinishedJobs(
  deps: { db: Pick<Db, 'delete'> },
  now: Date = new Date(),
  {
    doneOlderThanMs = 86_400_000,
    failedOlderThanMs = 30 * 86_400_000,
  }: { doneOlderThanMs?: number; failedOlderThanMs?: number } = {},
): Promise<number> {
  const doneCutoff = new Date(now.getTime() - doneOlderThanMs);
  const failedCutoff = new Date(now.getTime() - failedOlderThanMs);
  let total = 0;
  // Пачками (короткі блокування таблиці), доки пачка повна.
  for (;;) {
    const [res] = await deps.db
      .delete(jobs)
      .where(
        or(
          and(eq(jobs.status, 'done'), lt(jobs.updatedAt, doneCutoff)),
          and(eq(jobs.status, 'failed'), lt(jobs.updatedAt, failedCutoff)),
        ),
      )
      .limit(PURGE_FINISHED_BATCH);
    total += res.affectedRows;
    if (res.affectedRows < PURGE_FINISHED_BATCH) return total;
  }
}
