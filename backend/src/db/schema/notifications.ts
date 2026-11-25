import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { NotificationCategory, NotificationParams } from '@nri/shared';
import { users } from './users.js';

// Значення enum-ів — тут (drizzle-kit не вантажить ESM @nri/shared), збіг перевіряє `satisfies`.
const NOTIFICATION_CATEGORIES = [
  'applications',
  'members',
  'sessions',
  'reminders',
  'games',
] as const satisfies NotificationCategory[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Сповіщення користувача. `event_id` — подія-джерело (`NULL` для нагадувань);
 * UNIQUE(event_id, user_id) не дає повторній обробці події створити дубль (NULL-и не конфліктують).
 * `payload` — знімок `NotificationParams` на момент створення (лише дані, видимі отримувачу).
 */
export const notifications = mysqlTable(
  'notifications',
  {
    id: id('id').autoincrement().primaryKey(),
    // Без FK: події — журнал, і чистка подій не повинна чіпати сповіщення.
    eventId: id('event_id'),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    category: mysqlEnum('category', NOTIFICATION_CATEGORIES).notNull(),
    payload: json('payload').$type<NotificationParams>().notNull(),
    entityType: varchar('entity_type', { length: 32 }),
    entityId: id('entity_id'),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    readAt: datetime('read_at', { fsp: 3 }),
  },
  (t) => [
    uniqueIndex('notifications_event_id_user_id_uq').on(t.eventId, t.userId),
    index('notifications_user_id_id_idx').on(t.userId, sql`${t.id} desc`),
    index('notifications_user_id_read_at_idx').on(t.userId, t.readAt),
  ],
);

/**
 * Налаштування сповіщень. Рядка немає — значення за замовчуванням
 * (`defaultNotificationPrefs` у `@nri/shared`).
 */
export const notificationPrefs = mysqlTable('notification_prefs', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  telegram: json('telegram').$type<Record<NotificationCategory, boolean>>().notNull(),
  reminderOffsets: json('reminder_offsets').$type<number[]>().notNull(),
  updatedAt: datetime('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => new Date()),
});
