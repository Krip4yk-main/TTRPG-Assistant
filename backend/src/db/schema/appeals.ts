import { sql } from 'drizzle-orm';
import { bigint, datetime, int, mysqlTable, text, uniqueIndex } from 'drizzle-orm/mysql-core';
import { users } from './users.js';

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/** Апеляції на системний бан: одна на період бану (`users.ban_epoch`). */
export const banAppeals = mysqlTable(
  'ban_appeals',
  {
    id: id('id').autoincrement().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ≤ 2000 символів (перевіряє `appealInputSchema`). */
    message: text('message').notNull(),
    banEpoch: int('ban_epoch').notNull(),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex('ban_appeals_user_id_ban_epoch_uq').on(t.userId, t.banEpoch)],
);
