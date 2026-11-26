import { bigint, datetime, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import { gameSessions } from './sessions.js';
import { users } from './users.js';

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Розумне перенесення (Plan 12): стан сповіщення майстру «учасник не зможе прийти» на пару
 * (сесія, учасник). `declined_at` — останнє «не буду»; `notified_at` — коли цього учасника
 * востаннє включили в сповіщення. Джоб `schedule.rsvp_declined` надсилає лише тим, у кого
 * RSVP досі `not_going` і `declined_at > notified_at` (з затримкою й паузою між повторами,
 * див. `RSVP_DECLINE_*`). Повернув «буду» до доставки — його RSVP уже не `not_going`, пропуск.
 */
export const rsvpDeclineNotices = mysqlTable(
  'rsvp_decline_notices',
  {
    sessionId: id('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    declinedAt: datetime('declined_at', { fsp: 3 }).notNull(),
    notifiedAt: datetime('notified_at', { fsp: 3 }),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.userId] }),
    index('rsvp_decline_notices_declined_at_idx').on(t.declinedAt),
  ],
);

/**
 * Нагадування про порожній календар (Plan 12): одне на користувача назавжди — рядок
 * вставляється в транзакції разом зі сповіщенням (PK не дає дубля при повторі джоба).
 * `game_id` — кампейн, з якого почалось (довідково, без FK).
 */
export const calendarReminders = mysqlTable('calendar_reminders', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  gameId: id('game_id'),
  sentAt: datetime('sent_at', { fsp: 3 }).notNull(),
});
