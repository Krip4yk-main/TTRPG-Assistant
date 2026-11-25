import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { events } from '../db/schema/index.js';
import {
  emitNotificationsNew,
  insertEventNotifications,
  type NotificationRow,
} from './notifications.service.js';
import { planNotifications, type EventRow } from './recipients.js';

export const DISPATCH_JOB = 'notifications.dispatch';
export const DISPATCH_EVERY_MS = 10_000;
export const DISPATCH_BATCH = 200;
/** Скільки пачок поспіль за один запуск задачі (решта — наступного разу). */
const MAX_BATCHES_PER_RUN = 10;
const ERROR_MAX_LEN = 255;

/** Точка для тестів: викликається в транзакції пачки перед створенням сповіщень. */
export const dispatchHooks: { beforePlan?: (batch: EventRow[]) => Promise<void> } = {};

type BatchResult = { taken: number; created: NotificationRow[] };

/**
 * Пачка в одній транзакції (READ COMMITTED): до `limit` подій з `dispatched_at IS NULL` за
 * зростанням id `FOR UPDATE SKIP LOCKED` (незакомічені вставки й пачки паралельного
 * диспетчера пропускаються) → сповіщення (з хуком `afterNotificationsCreated` усередині
 * транзакції) → `dispatched_at` для всіх взятих, і тих, що нікого не сповіщають.
 * `onTaken` отримує id взятих подій ще до можливої помилки.
 */
async function dispatchBatch(
  deps: AppDeps,
  limit: number,
  now: Date | undefined,
  onTaken?: (ids: number[]) => void,
): Promise<BatchResult> {
  return deps.db.transaction(
    async (tx) => {
      const batch = await tx
        .select()
        .from(events)
        .where(isNull(events.dispatchedAt))
        .orderBy(asc(events.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (batch.length === 0) return { taken: 0, created: [] };
      onTaken?.(batch.map((e) => e.id));
      await dispatchHooks.beforePlan?.(batch);
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
}

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_LEN) || 'error';

/**
 * Обробляє одну пачку outbox-подій; пінги `notification.new` — після коміту. Якщо пачка
 * падає, ті самі події обробляються поодинці: подія, що падає й сама («отруйна»),
 * позначається обробленою з `dispatch_error` (і логом), щоб не блокувати чергу.
 * Повертає кількість оброблених подій.
 */
export async function dispatchEvents(
  deps: AppDeps,
  { limit = DISPATCH_BATCH, now }: { limit?: number; now?: Date } = {},
): Promise<number> {
  let ids: number[] = [];
  try {
    const r = await dispatchBatch(deps, limit, now, (taken) => (ids = taken));
    emitNotificationsNew(deps, r.created);
    return r.taken;
  } catch (err) {
    if (ids.length === 0) throw err; // збій до вибірки (БД недоступна) — повторить задача
    console.error(
      `notifications dispatch: batch of ${ids.length} failed, retrying one by one`,
      err,
    );
  }
  let taken = 0;
  for (const id of ids) taken += await dispatchSingle(deps, id, now);
  return taken;
}

async function dispatchSingle(deps: AppDeps, id: number, now: Date | undefined): Promise<number> {
  try {
    const r = await deps.db.transaction(
      async (tx) => {
        const [ev] = await tx
          .select()
          .from(events)
          .where(and(eq(events.id, id), isNull(events.dispatchedAt)))
          .for('update', { skipLocked: true });
        if (!ev) return { taken: 0, created: [] };
        await dispatchHooks.beforePlan?.([ev]);
        const created = await insertEventNotifications(deps, tx, await planNotifications(tx, [ev]));
        await tx
          .update(events)
          .set({ dispatchedAt: now ?? new Date() })
          .where(eq(events.id, id));
        return { taken: 1, created };
      },
      { isolationLevel: 'read committed' },
    );
    emitNotificationsNew(deps, r.created);
    return r.taken;
  } catch (err) {
    console.error(`notifications dispatch: event ${id} failed, skipping`, err);
    const [res] = await deps.db
      .update(events)
      .set({ dispatchedAt: now ?? new Date(), dispatchError: errorText(err) })
      .where(and(eq(events.id, id), isNull(events.dispatchedAt)));
    return res.affectedRows;
  }
}

/** Обробник задачі: пачки, доки черга не спорожніє (не більше `MAX_BATCHES_PER_RUN`). */
export async function runDispatch(deps: AppDeps): Promise<void> {
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    if ((await dispatchEvents(deps)) < DISPATCH_BATCH) return;
  }
}
