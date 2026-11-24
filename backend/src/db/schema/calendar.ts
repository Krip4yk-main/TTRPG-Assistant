import { sql } from 'drizzle-orm';
import { bigint, boolean, datetime, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import { games } from './games.js';
import { users } from './users.js';

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/** Налаштування користувача; рядка може не бути — тоді діють значення за замовчуванням. */
export const userSettings = mysqlTable('user_settings', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Сесії моїх ігор автоматично займають час у календарі. */
  calendarAutoBusy: boolean('calendar_autobusy').notNull().default(true),
});

/** Ігри, додані в календар вручну (коли автозайнятість вимкнено). */
export const calendarPinnedGames = mysqlTable(
  'calendar_pinned_games',
  {
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.gameId] }),
    index('calendar_pinned_games_game_id_idx').on(t.gameId),
  ],
);
