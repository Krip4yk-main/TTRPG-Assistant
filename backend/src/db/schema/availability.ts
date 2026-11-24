import { bigint, char, mysqlTable, primaryKey, smallint, tinyint } from 'drizzle-orm/mysql-core';
import { users } from './users.js';

const userRef = () =>
  bigint('user_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const availabilitySlots = mysqlTable(
  'availability_slots',
  {
    userId: userRef(),
    weekday: tinyint('weekday').notNull(),
    startMin: smallint('start_min').notNull(),
    endMin: smallint('end_min').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.weekday, t.startMin] })],
);

export const availabilityBusyDates = mysqlTable(
  'availability_busy_dates',
  {
    userId: userRef(),
    date: char('date', { length: 10 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);
