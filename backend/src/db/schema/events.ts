import { sql } from 'drizzle-orm';
import { bigint, datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const events = mysqlTable(
  'events',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }),
    entityType: varchar('entity_type', { length: 32 }),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }),
    payload: json('payload'),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('events_type_created_at_idx').on(t.type, t.createdAt)],
);
