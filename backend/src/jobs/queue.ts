import { and, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema/index.js';
import { isDuplicateKey } from '../auth/identity.service.js';

export type EnqueueOptions = {
  type: string;
  payload?: unknown;
  /** За замовчуванням — зараз. */
  runAt?: Date;
  /** Дедуплікація: задача з таким ключем уже є (у будь-якому статусі) → no-op. */
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

/** Видаляє завершені задачі, що востаннє змінювалися раніше за поріг (за `updated_at`). */
export async function purgeFinishedJobs(
  deps: { db: Pick<Db, 'delete'> },
  now: Date = new Date(),
  {
    doneOlderThanMs = 86_400_000,
    failedOlderThanMs = 30 * 86_400_000,
  }: { doneOlderThanMs?: number; failedOlderThanMs?: number } = {},
): Promise<number> {
  const [res] = await deps.db
    .delete(jobs)
    .where(
      or(
        and(eq(jobs.status, 'done'), lt(jobs.updatedAt, new Date(now.getTime() - doneOlderThanMs))),
        and(
          eq(jobs.status, 'failed'),
          lt(jobs.updatedAt, new Date(now.getTime() - failedOlderThanMs)),
        ),
      ),
    );
  return res.affectedRows;
}
