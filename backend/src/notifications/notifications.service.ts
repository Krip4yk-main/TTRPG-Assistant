import { and, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  NOTIFICATION_NEW_EVENT,
  defaultNotificationPrefs,
  notificationLink,
  notificationPrefsInputSchema,
  notificationsQuerySchema,
  SITE_OPTIONAL_CATEGORIES,
  type NotificationCategory,
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
import { enqueueTelegram } from './telegram-outbox.js';

export type NotificationRow = typeof notifications.$inferSelect;
type DbLike = Db | Tx;

/**
 * Викликається в транзакції, що створила сповіщення (лише нові рядки): ставить рядки
 * `telegram_outbox` (за прив'язкою Telegram і `prefs.telegram`, див. `enqueueTelegram`).
 * Працює ВСЕРЕДИНІ транзакції пачки диспетчера (і транзакції викликача `createNotification`):
 * лише записи через `tx`, без мережевих викликів; помилка тут відкочує всю пачку — диспетчер
 * повторить події поодинці, а подію, що падає й сама, пропустить із `dispatch_error`.
 */
export async function afterNotificationsCreated(
  deps: Pick<AppDeps, 'env'>,
  rows: NotificationRow[],
  tx: DbLike,
): Promise<void> {
  void deps;
  await enqueueTelegram(tx, rows);
}

const isSiteOptional = (c: NotificationCategory): boolean =>
  (SITE_OPTIONAL_CATEGORIES as readonly string[]).includes(c);

/**
 * Прибирає сповіщення категорій, які одержувач вимкнув на сайті (`prefs.site`, напр. «Розклад»):
 * такі не створюються взагалі — ні на сайті, ні в Telegram. Один запит, лише якщо є такі категорії.
 */
export async function dropSiteMuted<T extends Pick<NewNotification, 'userId' | 'category'>>(
  tx: DbLike,
  list: T[],
): Promise<T[]> {
  const optional = list.filter((n) => isSiteOptional(n.category));
  if (optional.length === 0) return list;
  const rows = await tx
    .select({ userId: notificationPrefs.userId, site: notificationPrefs.site })
    .from(notificationPrefs)
    .where(inArray(notificationPrefs.userId, [...new Set(optional.map((n) => n.userId))]));
  const site = new Map(rows.map((r) => [r.userId, r.site ?? {}]));
  return list.filter(
    (n) =>
      !isSiteOptional(n.category) ||
      (site.get(n.userId) as Record<string, boolean> | undefined)?.[n.category] !== false,
  );
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
 * Вставляє сповіщення з подій і викликає `afterNotificationsCreated` для нових. Трійка
 * (event_id, user_id, category), що вже є, пропускається (UNIQUE + `ON DUPLICATE KEY UPDATE id = id`).
 * Викликати в транзакції, що тримає блокування цих подій.
 */
export async function insertEventNotifications(
  deps: Pick<AppDeps, 'env'>,
  tx: DbLike,
  planned: NewNotification[],
): Promise<NotificationRow[]> {
  const list = await dropSiteMuted(tx, planned);
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

/**
 * Як `createNotification`, але для категорій, що вимикаються на сайті (`SITE_OPTIONAL_CATEGORIES`):
 * одержувач вимкнув категорію — `null`, нічого не створено.
 */
export async function createOptionalNotification(
  deps: Pick<AppDeps, 'env'>,
  tx: DbLike,
  input: Omit<NewNotification, 'eventId'>,
): Promise<NotificationRow | null> {
  const [kept] = await dropSiteMuted(tx, [input]);
  return kept ? createNotification(deps, tx, kept) : null;
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

/** Видаляє своє сповіщення; чуже чи неіснуюче — 404. */
export async function deleteNotification(deps: AppDeps, userId: number, id: number): Promise<void> {
  const [res] = await deps.db
    .delete(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));
  if (res.affectedRows === 0) throw new AppError(404, 'NOT_FOUND');
}

/** Видаляє всі свої прочитані сповіщення; повертає кількість. */
export async function deleteReadNotifications(
  deps: AppDeps,
  userId: number,
): Promise<{ deleted: number }> {
  const [res] = await deps.db
    .delete(notifications)
    .where(and(eq(notifications.userId, userId), isNotNull(notifications.readAt)));
  return { deleted: res.affectedRows };
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
    site: { ...d.site, ...(row.site ?? {}) },
    reminderOffsets: row.reminderOffsets as ReminderOffset[],
    quietHours: {
      enabled: row.quietHoursEnabled,
      start: row.quietHoursStart,
      end: row.quietHoursEnd,
    },
  };
}

export async function putPrefs(
  deps: AppDeps,
  userId: number,
  body: unknown,
): Promise<NotificationPrefsDto> {
  const input = notificationPrefsInputSchema.parse(body);
  // Не передані `site` / `quietHours` / `telegram.schedule` (старий клієнт) — лишаються збереженими.
  const current = await getPrefs(deps, userId);
  const telegram = { ...current.telegram, ...stripUndefined(input.telegram) };
  const site = input.site ?? current.site;
  const quiet = input.quietHours ?? current.quietHours;
  const set = {
    telegram,
    site,
    reminderOffsets: input.reminderOffsets,
    quietHoursEnabled: quiet.enabled,
    quietHoursStart: quiet.start,
    quietHoursEnd: quiet.end,
  };
  await deps.db
    .insert(notificationPrefs)
    .values({ userId, ...set })
    .onDuplicateKeyUpdate({ set });
  return getPrefs(deps, userId);
}

const stripUndefined = <T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
