import { sql } from 'drizzle-orm';
import { bigint, datetime, mysqlEnum, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';

/**
 * Реєстр демо-даних локальної розробки (`npm run seed:demo`): які користувачі й ігри створив
 * сидер. Без FK (поліморфний `entity_id`): `--reset` видаляє лише перелічене тут, а рядки
 * пишуться в тій самій транзакції, що й самі дані.
 */
export const demoEntities = mysqlTable(
  'demo_entities',
  {
    entityType: mysqlEnum('entity_type', ['user', 'game']).notNull(),
    entityId: bigint('entity_id', { mode: 'number', unsigned: true }).notNull(),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [primaryKey({ columns: [t.entityType, t.entityId], name: 'demo_entities_pk' })],
);
