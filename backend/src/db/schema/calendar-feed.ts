import { bigint, char, datetime, mysqlTable } from 'drizzle-orm/mysql-core';
import { users } from './users.js';

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Вихідна ICS-підписка на «мої сесії» (Plan 13 Task 10), одна на користувача. Сам токен
 * (≥ 32 випадкові байти, base64url) не зберігається — лише його SHA-256 (hex); пошук фіду —
 * за хешем. Перевипуск замінює хеш (старе посилання одразу перестає працювати), вимкнення
 * видаляє рядок. `last_access_at` — останнє завантаження фіду (не частіше ніж раз на хвилину).
 */
export const calendarFeeds = mysqlTable('calendar_feeds', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
  createdAt: datetime('created_at', { fsp: 3 }).notNull(),
  lastAccessAt: datetime('last_access_at', { fsp: 3 }),
});
