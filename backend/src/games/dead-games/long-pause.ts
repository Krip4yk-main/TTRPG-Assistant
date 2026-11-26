import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { LONG_PAUSE_REMIND_MS, LONG_PAUSE_REPEAT_MS } from '@nri/shared';
import type { AppDeps } from '../../app.js';
import { isTransientDbError } from '../../db/errors.js';
import { games, users } from '../../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../../notifications/notifications.service.js';
import { keepUpdatedAt } from './rules.js';

export const LONG_PAUSE_JOB = 'games.long_pause_reminder';
export const LONG_PAUSE_AT_UTC = '04:15';

type Deps = Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>;

/**
 * Чи належить нагадування про довгу паузу на момент `now` (умова й для вибірки, і для
 * атомарного оновлення): гра на паузі понад 90 днів, а нагадування цієї паузи ще не було
 * (`long_pause_reminded_at` порожнє чи раніше за `paused_at` — з попередньої паузи) або було
 * щонайменше 30 днів тому.
 */
const due = (now: Date) =>
  and(
    eq(games.status, 'paused'),
    lte(games.pausedAt, new Date(now.getTime() - LONG_PAUSE_REMIND_MS)),
    or(
      isNull(games.longPauseRemindedAt),
      lt(games.longPauseRemindedAt, games.pausedAt),
      lte(games.longPauseRemindedAt, new Date(now.getTime() - LONG_PAUSE_REPEAT_MS)),
    ),
  );

/**
 * Щоденне нагадування майстру про довгу паузу кампейну (`game.long_pause`, категорія
 * `games`, посилання — сторінка гри з діями «Відновити» / «Оголосити донабір» / «Завершити»).
 * Час нагадування — `games.long_pause_reminded_at`: умовне оновлення в транзакції разом зі
 * сповіщенням, тож повтор задачі, перезапуск сервера чи паралельний прогін не дублюють його.
 * Майстру з неактивним акаунтом сповіщення не створюється (позначка часу — ставиться).
 * Повертає id ігор, про які нагадано.
 */
export async function runLongPauseReminders(deps: Deps, now: Date): Promise<number[]> {
  const rows = await deps.db
    .select({
      id: games.id,
      title: games.title,
      gmUserId: games.gmUserId,
      gmStatus: users.status,
      gmBanned: users.isBanned,
    })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(due(now));
  const reminded: number[] = [];
  const created: NotificationRow[] = [];
  let failure: unknown;
  for (const g of rows) {
    try {
      const n = await deps.db.transaction(async (tx) => {
        const [res] = await tx
          .update(games)
          .set({ longPauseRemindedAt: now, ...keepUpdatedAt })
          .where(and(eq(games.id, g.id), due(now)));
        if (res.affectedRows === 0) return undefined;
        if (g.gmStatus !== 'active' || g.gmBanned) return null;
        return createNotification(deps, tx, {
          userId: g.gmUserId,
          type: 'game.long_pause',
          category: 'games',
          params: { gameId: g.id, gameTitle: g.title },
          entityType: 'game',
          entityId: g.id,
        });
      });
      if (n === undefined) continue;
      reminded.push(g.id);
      if (n) created.push(n);
    } catch (err) {
      console.error(`long pause: game ${g.id} failed`, err);
      if (isTransientDbError(err)) failure ??= err;
    }
  }
  emitNotificationsNew(deps, created);
  if (failure) throw failure;
  return reminded;
}
