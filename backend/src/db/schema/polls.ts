import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  tinyint,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import type { PollCloseReason, PollKind, PollStatus, PollVoteValue, Weekday } from '@nri/shared';
import { games } from './games.js';
import { gameSessions } from './sessions.js';
import { users } from './users.js';

// Значення enum-ів — тут (drizzle-kit не вантажить ESM @nri/shared), збіг перевіряє `satisfies`.
const POLL_KINDS = ['regular', 'one_off'] as const satisfies PollKind[];
const POLL_STATUSES = ['open', 'closed'] as const satisfies PollStatus[];
const POLL_CLOSE_REASONS = ['all_voted', 'deadline', 'gm'] as const satisfies PollCloseReason[];
const POLL_VOTE_VALUES = ['yes', 'no', 'maybe'] as const satisfies PollVoteValue[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Голосування за час (Plan 12). Закриття — умовним `UPDATE … WHERE status='open'`: хто змінив
 * рядок (усі проголосували / джоб дедлайну / майстер), той і пише подію `poll.closed`, тож
 * сповіщення майстру — рівно одне. Застосування — так само за `applied_at IS NULL`.
 * `session_id` — сесія, яку переносимо (разове голосування); `duration_minutes` — знімок
 * тривалості гри на момент створення.
 */
export const polls = mysqlTable(
  'polls',
  {
    id: id('id').autoincrement().primaryKey(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    kind: mysqlEnum('kind', POLL_KINDS).notNull(),
    status: mysqlEnum('status', POLL_STATUSES).notNull().default('open'),
    closeReason: mysqlEnum('close_reason', POLL_CLOSE_REASONS),
    sessionId: id('session_id').references(() => gameSessions.id, { onDelete: 'set null' }),
    durationMinutes: smallint('duration_minutes').notNull(),
    closesAt: datetime('closes_at', { fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    closedAt: datetime('closed_at', { fsp: 3 }),
    appliedAt: datetime('applied_at', { fsp: 3 }),
    // Без FK: варіант і сесія — довідково (сесію можуть видалити заміною правила).
    appliedOptionId: id('applied_option_id'),
    appliedSessionId: id('applied_session_id'),
  },
  (t) => [
    index('polls_game_id_status_idx').on(t.gameId, t.status),
    // Джоб дедлайнів: `status='open' AND closes_at <= now`.
    index('polls_status_closes_at_idx').on(t.status, t.closesAt),
  ],
);

/**
 * Варіанти голосування: `regular` — `weekday`/`start_min` у поясі гри (`starts_at` — найближча
 * сесія на момент створення, для показу); `one_off` — `starts_at`.
 */
export const pollOptions = mysqlTable(
  'poll_options',
  {
    id: id('id').autoincrement().primaryKey(),
    pollId: id('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    position: tinyint('position').notNull(),
    weekday: tinyint('weekday').$type<Weekday>(),
    startMin: smallint('start_min'),
    startsAt: datetime('starts_at').notNull(),
  },
  (t) => [uniqueIndex('poll_options_poll_id_position_uq').on(t.pollId, t.position)],
);

/** Відповідь учасника на варіант; одна на (варіант, користувач), змінюється до закриття. */
export const pollVotes = mysqlTable(
  'poll_votes',
  {
    optionId: id('option_id')
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pollId: id('poll_id')
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    value: mysqlEnum('value', POLL_VOTE_VALUES).notNull(),
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.optionId, t.userId] }),
    index('poll_votes_poll_id_user_id_idx').on(t.pollId, t.userId),
    index('poll_votes_user_id_idx').on(t.userId),
  ],
);
