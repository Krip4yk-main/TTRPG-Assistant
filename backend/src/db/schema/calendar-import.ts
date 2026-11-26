import { bigint, datetime, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { users } from './users.js';

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Підключене iCal-посилання (Plan 12 Task 4), одне на користувача. `url_enc` — посилання,
 * зашифроване AES-256-GCM ключем `CALENDAR_IMPORT_KEY` (`v1.<iv>.<tag>.<ct>`, AAD — id
 * користувача); у відкритому вигляді посилання не зберігається й не повертається API. `host` —
 * лише для показу («підключено calendar.google.com»).
 *
 * Стан синхронізації: `last_sync_at` — остання успішна; `last_attempt_at` — остання спроба
 * (і межа ручного «Оновити»); `last_error` — код причини (`CalendarImportErrorCode`), без
 * подробиць і без посилання; `failures` — невдач поспіль; `broken_at` — після
 * `CALENDAR_IMPORT_MAX_FAILURES` невдач автооновлення зупинено (дані видалено, сповіщення
 * `calendar.import_broken` — один раз), поки користувач не збереже посилання знову або не
 * оновить вручну успішно.
 */
export const calendarImports = mysqlTable(
  'calendar_imports',
  {
    userId: id('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    urlEnc: varchar('url_enc', { length: 4096 }).notNull(),
    host: varchar('host', { length: 255 }).notNull(),
    lastSyncAt: datetime('last_sync_at', { fsp: 3 }),
    lastAttemptAt: datetime('last_attempt_at', { fsp: 3 }),
    lastError: varchar('last_error', { length: 32 }),
    failures: int('failures').notNull().default(0),
    brokenAt: datetime('broken_at', { fsp: 3 }),
    eventsCount: int('events_count').notNull().default(0),
    createdAt: datetime('created_at', { fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { fsp: 3 }).notNull(),
  },
  (t) => [index('calendar_imports_last_attempt_idx').on(t.brokenAt, t.lastAttemptAt)],
);

/**
 * Імпортовані інтервали зайнятості `[starts_at, ends_at)` (UTC) на горизонті 8 тижнів —
 * злиті, без назв/описів/місць подій. Замінюються атомарно на кожній синхронізації.
 */
export const calendarImportBusy = mysqlTable(
  'calendar_import_busy',
  {
    id: id('id').autoincrement().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startsAt: datetime('starts_at', { fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { fsp: 3 }).notNull(),
  },
  (t) => [index('calendar_import_busy_user_starts_idx').on(t.userId, t.startsAt)],
);
