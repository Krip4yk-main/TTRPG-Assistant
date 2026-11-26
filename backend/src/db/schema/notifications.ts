import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type {
  NotificationCategory,
  NotificationParams,
  SiteOptionalCategory,
  TelegramButton,
} from '@nri/shared';
import { gameSessions } from './sessions.js';
import { users } from './users.js';

// Значення enum-ів — тут (drizzle-kit не вантажить ESM @nri/shared), збіг перевіряє `satisfies`.
const NOTIFICATION_CATEGORIES = [
  'applications',
  'members',
  'sessions',
  'reminders',
  'games',
  'ratings',
  'moderation',
  'schedule',
] as const satisfies NotificationCategory[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Сповіщення користувача. `event_id` — подія-джерело (`NULL` для нагадувань);
 * UNIQUE(event_id, user_id, category) не дає повторній обробці події створити дубль (NULL-и не
 * конфліктують). Категорія в ключі: одна подія може сповістити того самого користувача в різних
 * категоріях (вихід учасника — майстру `member.left` і запрошення оцінити `rating.member_left`;
 * завершення гри — `game.finished` і `rating.final_open`), але не більше одного разу в кожній.
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
    uniqueIndex('notifications_event_user_category_uq').on(t.eventId, t.userId, t.category),
    index('notifications_user_id_id_idx').on(t.userId, sql`${t.id} desc`),
    index('notifications_user_id_read_at_idx').on(t.userId, t.readAt),
    // Чистка прочитаних, старших 90 днів (Task 3).
    index('notifications_read_at_idx').on(t.readAt),
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
  // Partial: рядки, збережені до появи нової категорії, її не містять — читаються зі злиттям
  // зі значеннями за замовчуванням (`getPrefs`, `enqueueTelegram`).
  telegram: json('telegram').$type<Partial<Record<NotificationCategory, boolean>>>().notNull(),
  reminderOffsets: json('reminder_offsets').$type<number[]>().notNull(),
  /** Сповіщення на сайті для категорій, що вимикаються (`SITE_OPTIONAL_CATEGORIES`); NULL — усі ввімкнено. */
  site: json('site').$type<Partial<Record<SiteOptionalCategory, boolean>>>(),
  updatedAt: datetime('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => new Date()),
});

/**
 * Журнал надісланих нагадувань (Task 3). UNIQUE(session_id, user_id, offset_min, starts_at):
 * повторний чи паралельний прогін не дублює нагадування, а перенесена сесія (новий
 * `starts_at`) отримує свіжі нагадування за новим часом. Старші 30 днів чистить щоденна задача.
 */
export const reminderLog = mysqlTable(
  'reminder_log',
  {
    id: id('id').autoincrement().primaryKey(),
    sessionId: id('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    offsetMin: smallint('offset_min').notNull(),
    startsAt: datetime('starts_at', { fsp: 3 }).notNull(),
    sentAt: datetime('sent_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex('reminder_log_session_user_offset_starts_uq').on(
      t.sessionId,
      t.userId,
      t.offsetMin,
      t.startsAt,
    ),
    index('reminder_log_user_id_idx').on(t.userId),
    index('reminder_log_sent_at_idx').on(t.sentAt),
  ],
);

export const TELEGRAM_OUTBOX_STATUSES = ['pending', 'sent', 'failed'] as const;

/**
 * Черга Telegram-повідомлень (Task 4). Рядок ставиться в транзакції, що створила сповіщення,
 * лише якщо в користувача є Telegram-ідентичність і категорія ввімкнена; UNIQUE(notification_id)
 * — одне повідомлення на сповіщення. Бот забирає пачки через внутрішній API
 * (`locked_until` — лок видачі), рендерить `kind` + `params` своїм i18n. `chat_id` — Telegram
 * id користувача (приватний чат). Надіслані/невдалі, старші 30 днів, чистить щоденна задача.
 */
export const telegramOutbox = mysqlTable(
  'telegram_outbox',
  {
    id: id('id').autoincrement().primaryKey(),
    notificationId: id('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    userId: id('user_id').notNull(),
    chatId: varchar('chat_id', { length: 32 }).notNull(),
    kind: varchar('kind', { length: 64 }).notNull(),
    params: json('params').$type<NotificationParams>().notNull(),
    buttons: json('buttons').$type<TelegramButton[]>(),
    status: mysqlEnum('status', TELEGRAM_OUTBOX_STATUSES).notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    nextTryAt: datetime('next_try_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    lockedUntil: datetime('locked_until', { fsp: 3 }),
    lastError: varchar('last_error', { length: 255 }),
    /** IANA-пояс одержувача на момент постановки (`users.timezone`) — для дат у тексті. */
    timeZone: varchar('time_zone', { length: 64 }),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('telegram_outbox_notification_id_uq').on(t.notificationId),
    index('telegram_outbox_status_next_try_at_idx').on(t.status, t.nextTryAt),
    // Видача FIFO: `WHERE status='pending' … ORDER BY id LIMIT n` без filesort.
    index('telegram_outbox_status_id_idx').on(t.status, t.id),
    index('telegram_outbox_chat_id_status_idx').on(t.chatId, t.status),
    index('telegram_outbox_updated_at_idx').on(t.updatedAt),
  ],
);
