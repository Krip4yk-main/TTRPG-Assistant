import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  NOTIFICATION_NEW_EVENT,
  defaultNotificationPrefs,
  notificationLink,
  notificationPrefsInputSchema,
  notificationsQuerySchema,
  type NotificationDto,
  type NotificationPrefsDto,
  type NotificationsPage,
  type NotificationType,
  type ReminderOffset,
  type UnreadCountDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { notificationPrefs, notifications } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import type { NewNotification } from './recipients.js';

export type NotificationRow = typeof notifications.$inferSelect;
type DbLike = Db | Tx;

/**
 * Точка розширення: викликається в транзакції, що створила сповіщення (лише нові рядки).
 * Task 4 ставить тут рядки `telegram_outbox` (за прив'язкою Telegram і `prefs.telegram`).
 * Працює ВСЕРЕДИНІ транзакції пачки диспетчера (і транзакції викликача `createNotification`):
 * лише записи через `tx`, без мережевих викликів; помилка тут відкочує всю пачку — диспетчер
 * повторить події поодинці, а подію, що падає й сама, пропустить із `dispatch_error`.
 */
export async function afterNotificationsCreated(
  deps: Pick<AppDeps, 'env'>,
  rows: NotificationRow[],
  tx: DbLike,
): Promise<void> {
  // no-op до Task 4 (telegram_outbox)
  void deps;
  void rows;
  void tx;
}

const toInsert = (n: NewNotification) => ({
  eventId: n.eventId,
  userId: n.userId,
  type: n.type,
  category: n.category,
  payload: n.params,
  entityType: n.entityType,
  entityId: n.entityId,
});

/**
 * Вставляє сповіщення з подій і викликає `afterNotificationsCreated` для нових. Пара
 * (event_id, user_id), що вже є, пропускається (UNIQUE + `ON DUPLICATE KEY UPDATE id = id`).
 * Викликати в транзакції, що тримає блокування цих подій.
 */
export async function insertEventNotifications(
  deps: Pick<AppDeps, 'env'>,
  tx: DbLike,
  list: NewNotification[],
): Promise<NotificationRow[]> {
  if (list.length === 0) return [];
  const eventIds = [...new Set(list.map((n) => n.eventId!))];
  const existing = new Set(
    (
      await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(inArray(notifications.eventId, eventIds))
    ).map((r) => r.id),
  );
  await tx
    .insert(notifications)
    .values(list.map(toInsert))
    .onDuplicateKeyUpdate({ set: { id: sql`${notifications.id}` } });
  const rows = (
    await tx.select().from(notifications).where(inArray(notifications.eventId, eventIds))
  ).filter((r) => !existing.has(r.id));
  await afterNotificationsCreated(deps, rows, tx);
  return rows;
}

/**
 * Одне сповіщення не з події (нагадування, Task 3): `eventId` = null, дедуплікація — на
 * стороні викликача (`reminder_log`). Після коміту викликача — `emitNotificationsNew`.
 */
export async function createNotification(
  deps: Pick<AppDeps, 'env'>,
  tx: DbLike,
  input: Omit<NewNotification, 'eventId'>,
): Promise<NotificationRow> {
  const [res] = await tx
    .insert(notifications)
    .values(toInsert({ ...input, eventId: null }))
    .$returningId();
  const [row] = await tx.select().from(notifications).where(eq(notifications.id, res!.id));
  await afterNotificationsCreated(deps, [row!], tx);
  return row!;
}

/** Пінг `notification.new {id}` у `user:<id>` — лише після коміту; без realtime — нічого. */
export function emitNotificationsNew(
  deps: Pick<AppDeps, 'realtime'>,
  rows: Pick<NotificationRow, 'id' | 'userId'>[],
): void {
  if (!deps.realtime) return;
  for (const r of rows) {
    try {
      deps.realtime.toUser(r.userId, NOTIFICATION_NEW_EVENT, { id: r.id });
    } catch (err) {
      console.error('notification.new emit failed', err);
    }
  }
}

// ---------- API ----------

export function toNotificationDto(r: NotificationRow): NotificationDto {
  const type = r.type as NotificationType;
  return {
    id: r.id,
    type,
    category: r.category,
    params: r.payload,
    link: notificationLink(type, r.payload),
    createdAt: r.createdAt.toISOString(),
    readAt: r.readAt ? r.readAt.toISOString() : null,
  };
}

export async function listNotifications(
  deps: AppDeps,
  userId: number,
  query: unknown,
): Promise<NotificationsPage> {
  const { cursor, limit } = notificationsQuerySchema.parse(query);
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        cursor !== undefined ? lt(notifications.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(toNotificationDto),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

export async function unreadCount(deps: AppDeps, userId: number): Promise<UnreadCountDto> {
  const [r] = await deps.db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return { count: r?.n ?? 0 };
}

/** Позначає своє сповіщення прочитаним (ідемпотентно); чуже чи неіснуюче — 404. */
export async function markRead(
  deps: AppDeps,
  userId: number,
  id: number,
): Promise<NotificationDto> {
  const own = and(eq(notifications.id, id), eq(notifications.userId, userId));
  await deps.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(own, isNull(notifications.readAt)));
  const [row] = await deps.db.select().from(notifications).where(own);
  if (!row) throw new AppError(404, 'NOT_FOUND');
  return toNotificationDto(row);
}

export async function markAllRead(deps: AppDeps, userId: number): Promise<void> {
  await deps.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

// ---------- налаштування ----------

/** Налаштування користувача (без рядка — за замовчуванням). */
export async function getPrefs(
  deps: { db: DbLike },
  userId: number,
): Promise<NotificationPrefsDto> {
  const [row] = await deps.db
    .select()
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId));
  const d = defaultNotificationPrefs();
  if (!row) return d;
  return {
    telegram: { ...d.telegram, ...row.telegram },
    reminderOffsets: row.reminderOffsets as ReminderOffset[],
  };
}

export async function putPrefs(
  deps: AppDeps,
  userId: number,
  body: unknown,
): Promise<NotificationPrefsDto> {
  const input = notificationPrefsInputSchema.parse(body);
  await deps.db
    .insert(notificationPrefs)
    .values({ userId, telegram: input.telegram, reminderOffsets: input.reminderOffsets })
    .onDuplicateKeyUpdate({
      set: { telegram: input.telegram, reminderOffsets: input.reminderOffsets },
    });
  return getPrefs(deps, userId);
}
