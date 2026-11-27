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
import type { RsvpStatus, SessionOrigin, SessionStatus } from '@nri/shared';
import { games } from './games.js';
import { users } from './users.js';

const SESSION_STATUSES = ['scheduled', 'done', 'cancelled'] as const satisfies SessionStatus[];
const SESSION_ORIGINS = ['rule', 'manual'] as const satisfies SessionOrigin[];
const RSVP_STATUSES = ['going', 'not_going'] as const satisfies RsvpStatus[];

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
    /** Коли підсумок надіслано учасникам (`session.summary`, один раз); `NULL` — ще ні. */
    summarySentAt: datetime('summary_sent_at', { fsp: 3 }),
    doneAt: datetime('done_at', { fsp: 3 }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    /** Зміни сесії (перенесення, скасування, завершення); RSVP не рахується. */
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
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

/** RSVP учасника на майбутню сесію («буду / не зможу»); один рядок на (сесія, користувач). */
export const sessionRsvp = mysqlTable(
  'session_rsvp',
  {
    sessionId: id('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', RSVP_STATUSES).notNull(),
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.userId] }),
    index('session_rsvp_user_id_idx').on(t.userId),
  ],
);
