import { and, asc, eq, isNull, ne, not } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { users } from '../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { telegramLinked } from './roles.service.js';

export const STAFF_TELEGRAM_JOB = 'staff.telegram_reminders';
export const STAFF_TELEGRAM_EVERY_MS = 15 * 60_000;
const BATCH = 100;

/**
 * Персонал без Telegram (План 20): наявні модератори/адміни/власник без прив'язаного Telegram
 * (дані до цього правила, локальні акаунти) ролі не втрачають, але отримують одне сповіщення на
 * сайті `staff.telegram_required` — прив'язати Telegram. Рівно один раз назавжди: умовний
 * UPDATE `users.staff_telegram_reminded_at IS NULL → now` у транзакції зі сповіщенням, тож
 * повтор, перезапуск чи паралельний прогін (кілька екземплярів) не дублюють. Лише активні
 * незабанені акаунти. Повертає id користувачів, яким створено сповіщення.
 */
export async function runStaffTelegramReminders(
  deps: Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>,
  now: Date,
): Promise<number[]> {
  const { db } = deps;
  const candidate = (tx: Pick<AppDeps['db'], 'select'>) =>
    and(
      ne(users.role, 'user'),
      eq(users.status, 'active'),
      eq(users.isBanned, false),
      isNull(users.staffTelegramRemindedAt),
      not(telegramLinked(tx, users.id)),
    );
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(candidate(db))
    .orderBy(asc(users.id))
    .limit(BATCH);
  const created: NotificationRow[] = [];
  for (const { id } of rows) {
    try {
      const row = await db.transaction(async (tx) => {
        const [res] = await tx
          .update(users)
          .set({ staffTelegramRemindedAt: now })
          .where(and(eq(users.id, id), candidate(tx)));
        if (res.affectedRows === 0) return null;
        return createNotification(deps, tx, {
          userId: id,
          type: 'staff.telegram_required',
          category: 'moderation',
          params: {},
          entityType: null,
          entityId: null,
        });
      });
      if (row) created.push(row);
    } catch (err) {
      // Наступний прогін повторить (позначка не поставилась разом із відкотом).
      console.error(`staff telegram reminder: user ${id} failed`, err);
    }
  }
  emitNotificationsNew(deps, created);
  return created.map((r) => r.userId);
}
