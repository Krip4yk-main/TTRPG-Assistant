import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { SessionOrigin, SessionStatus } from '@nri/shared';
import { games } from './games.js';
import { users } from './users.js';

const SESSION_STATUSES = ['scheduled', 'done', 'cancelled'] as const satisfies SessionStatus[];
const SESSION_ORIGINS = ['rule', 'manual'] as const satisfies SessionOrigin[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Матеріалізовані сесії гри. `rule_starts_at` — слот правила, з якого згенеровано сесію
 * (лишається незмінним після перенесення), тож повторна матеріалізація ідемпотентна.
 */
export const gameSessions = mysqlTable(
  'game_sessions',
  {
    id: id('id').autoincrement().primaryKey(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    startsAt: datetime('starts_at').notNull(),
    durationMinutes: smallint('duration_minutes').notNull(),
    status: mysqlEnum('status', SESSION_STATUSES).notNull().default('scheduled'),
    origin: mysqlEnum('origin', SESSION_ORIGINS).notNull(),
    ruleStartsAt: datetime('rule_starts_at'),
    rescheduled: boolean('rescheduled').notNull().default(false),
    cancelReason: varchar('cancel_reason', { length: 300 }),
    summary: text('summary'),
    doneAt: datetime('done_at'),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('game_sessions_game_id_rule_starts_at_uq').on(t.gameId, t.ruleStartsAt),
    index('game_sessions_game_id_starts_at_idx').on(t.gameId, t.startsAt),
    index('game_sessions_status_starts_at_idx').on(t.status, t.startsAt),
  ],
);

export const sessionAttendance = mysqlTable(
  'session_attendance',
  {
    sessionId: id('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    present: boolean('present').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.userId] }),
    index('session_attendance_user_id_idx').on(t.userId),
  ],
);
