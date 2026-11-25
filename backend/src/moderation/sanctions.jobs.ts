import { and, asc, isNotNull, isNull, lte } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { sanctions } from '../db/schema/index.js';
import { liftSanctionTx } from './sanctions.service.js';

export const EXPIRE_JOB = 'moderation.expire';
/** Задача строків — щохвилини: строкова санкція знімається не пізніше ніж за хвилину. */
export const EXPIRE_EVERY_MS = 60_000;
const BATCH = 200;

/**
 * Знімає санкції, чий строк минув до `now` (`ends_at <= now`), від імені системи: `lifted_at` =
 * `ends_at`, журнал `sanction.expire`, сповіщення `sanction.lifted`; бан — `is_banned=0` і
 * зняття позначки надгробків (якщо інших чинних банів немає). Обмеження й без задачі не діє
 * після `ends_at` (`activeAt`); задача — для бану й сповіщень. Кожна санкція — окрема
 * транзакція: збій однієї не зупиняє інші. Повертає кількість знятих.
 */
export async function expireSanctions(
  deps: Pick<AppDeps, 'db' | 'env' | 'redis'> & Partial<Pick<AppDeps, 'realtime'>>,
  now: Date = new Date(),
): Promise<number> {
  const due = await deps.db
    .select({ id: sanctions.id })
    .from(sanctions)
    .where(and(isNull(sanctions.liftedAt), isNotNull(sanctions.endsAt), lte(sanctions.endsAt, now)))
    .orderBy(asc(sanctions.endsAt), asc(sanctions.id))
    .limit(BATCH);
  let lifted = 0;
  let failure: unknown = null;
  for (const { id } of due) {
    try {
      const r = await deps.db.transaction((tx) =>
        liftSanctionTx(deps, tx, null, id, { now, expired: true }),
      );
      if (r) {
        lifted++;
        await r.afterCommit();
      }
    } catch (err) {
      console.error(`moderation.expire: sanction ${id} failed`, err);
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return lifted;
}
