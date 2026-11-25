import { bigint, datetime, mysqlEnum, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core';
import type { EntityViewType } from '@nri/shared';
import { users } from './users.js';

const ENTITY_VIEW_TYPES = ['game', 'application', 'session'] as const satisfies EntityViewType[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Коли користувач востаннє переглядав сутність (гра/заявка/сесія). Порівнюється з
 * `updated_at` сутності: немає рядка — `new`, `updated_at > viewed_at` — `updated`.
 * `entity_id` без FK (поліморфний); рядки видалених сутностей лишаються до видалення
 * користувача (дрібні, нешкідливі).
 */
export const entityViews = mysqlTable(
  'entity_views',
  {
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entityType: mysqlEnum('entity_type', ENTITY_VIEW_TYPES).notNull(),
    entityId: id('entity_id').notNull(),
    viewedAt: datetime('viewed_at', { fsp: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.entityType, t.entityId] })],
);
