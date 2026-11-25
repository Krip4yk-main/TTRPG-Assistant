import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ApplicationCancelReason, ApplicationStatus, ConstraintResponse } from '@nri/shared';
import { games } from './games.js';
import { users } from './users.js';

// Значення enum-ів — тут (drizzle-kit не вантажить ESM @nri/shared), збіг перевіряє `satisfies`.
const APPLICATION_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'cancelled',
] as const satisfies ApplicationStatus[];
const APPLICATION_CANCEL_REASONS = [
  'age_rating',
  'game_cancelled',
  'game_finished',
  'banned',
] as const satisfies ApplicationCancelReason[];
const CONSTRAINT_RESPONSES = [
  'accepted',
  'partial',
  'cannot_guarantee',
] as const satisfies ConstraintResponse[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

export interface StoredConstraint {
  id: string;
  text: string;
}

/**
 * Заявки на гру. Активна (`pending`) — не більше однієї на (гра, гравець): згенерований
 * `active_key` = `game:user` лише для `pending`, інакше NULL (NULL-и в UNIQUE не конфліктують).
 * VIRTUAL, бо MySQL забороняє CASCADE-FK на базових колонках STORED-колонки.
 */
export const gameApplications = mysqlTable(
  'game_applications',
  {
    id: id('id').autoincrement().primaryKey(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', APPLICATION_STATUSES).notNull().default('pending'),
    message: text('message'),
    answers: json('answers').$type<string[]>().notNull(),
    constraints: json('constraints').$type<StoredConstraint[]>().notNull(),
    warningsAcceptedAt: datetime('warnings_accepted_at').notNull(),
    cancelReason: mysqlEnum('cancel_reason', APPLICATION_CANCEL_REASONS),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    decidedAt: datetime('decided_at'),
    decidedBy: id('decided_by').references(() => users.id, { onDelete: 'set null' }),
    /** Будь-яка зміна заявки (статус, відповідь майстра на обмеження) — для стану «оновлено». */
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
    activeKey: varchar('active_key', { length: 41 }).generatedAlwaysAs(
      sql`IF(status = 'pending', CONCAT(game_id, ':', user_id), NULL)`,
      { mode: 'virtual' },
    ),
  },
  (t) => [
    uniqueIndex('game_applications_active_key_uq').on(t.activeKey),
    index('game_applications_game_id_status_idx').on(t.gameId, t.status),
    index('game_applications_user_id_idx').on(t.userId),
  ],
);

/** Відповідь майстра на кожне обмеження заявки. */
export const applicationConstraintResponses = mysqlTable(
  'application_constraint_responses',
  {
    applicationId: id('application_id').notNull(),
    constraintId: varchar('constraint_id', { length: 16 }).notNull(),
    response: mysqlEnum('response', CONSTRAINT_RESPONSES).notNull(),
    comment: varchar('comment', { length: 500 }),
    updatedAt: datetime('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.constraintId] }),
    // Автоназва FK задовга для MySQL (> 64 символів).
    foreignKey({
      name: 'acr_application_id_fk',
      columns: [t.applicationId],
      foreignColumns: [gameApplications.id],
    }).onDelete('cascade'),
  ],
);
