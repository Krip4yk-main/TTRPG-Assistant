import { asc, inArray, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { events } from '../db/schema/index.js';
import { emitNotificationsNew, insertEventNotifications } from './notifications.service.js';
import { planNotifications } from './recipients.js';

export const DISPATCH_JOB = 'notifications.dispatch';
export const DISPATCH_EVERY_MS = 10_000;
export const DISPATCH_BATCH = 200;
/** Скільки пачок поспіль за один запуск задачі (решта — наступного разу). */
const MAX_BATCHES_PER_RUN = 10;

/**
 * Одна пачка outbox-подій: у транзакції (READ COMMITTED) бере до `limit` подій з
 * `dispatched_at IS NULL` за зростанням id `FOR UPDATE SKIP LOCKED` (незакомічені вставки й
 * пачки паралельного диспетчера пропускаються), створює сповіщення й позначає всі взяті
 * події обробленими — і ті, що нікого не сповіщають. Пінги `notification.new` — після коміту.
 * Повертає кількість оброблених подій.
 */
export async function dispatchEvents(
  deps: AppDeps,
  { limit = DISPATCH_BATCH, now }: { limit?: number; now?: Date } = {},
): Promise<number> {
  const { taken, created } = await deps.db.transaction(
    async (tx) => {
      const batch = await tx
        .select()
        .from(events)
        .where(isNull(events.dispatchedAt))
        .orderBy(asc(events.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (batch.length === 0) return { taken: 0, created: [] };
      const created = await insertEventNotifications(deps, tx, await planNotifications(tx, batch));
      await tx
        .update(events)
        .set({ dispatchedAt: now ?? new Date() })
        .where(
          inArray(
            events.id,
            batch.map((e) => e.id),
          ),
        );
      return { taken: batch.length, created };
    },
    { isolationLevel: 'read committed' },
  );
  emitNotificationsNew(deps, created);
  return taken;
}

/** Обробник задачі: пачки, доки черга не спорожніє (не більше `MAX_BATCHES_PER_RUN`). */
export async function runDispatch(deps: AppDeps): Promise<void> {
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    if ((await dispatchEvents(deps)) < DISPATCH_BATCH) return;
  }
}
