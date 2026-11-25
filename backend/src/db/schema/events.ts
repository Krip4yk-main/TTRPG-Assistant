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
    /**
     * Коли диспетчер сповіщень обробив подію (`NULL` — ще ні). Outbox за прапорцем, а не за
     * курсором id: id видаються до коміту, тож «пізній» коміт курсор пропустив би.
     */
    dispatchedAt: datetime('dispatched_at', { fsp: 3 }),
    /** Подію не вдалося обробити й її пропущено (див. диспетчер); `NULL` — оброблено нормально. */
    dispatchError: varchar('dispatch_error', { length: 255 }),
  },
  (t) => [
    index('events_type_created_at_idx').on(t.type, t.createdAt),
    index('events_dispatched_at_id_idx').on(t.dispatchedAt, t.id),
  ],
);
