import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Черга фонових задач (див. `src/jobs`). `run_at`/`locked_until` — з мілісекундами (fsp 3),
 * бо datetime без дробу MySQL округлює, і задача «на зараз» могла б опинитися в майбутньому.
 * `unique_key` (NULL не конфліктує) — дедуплікація постановки: дубль → no-op.
 * `attempts` збільшується при кожному захопленні й слугує токеном власника запуску.
 */
export const jobs = mysqlTable(
  'jobs',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    runAt: datetime('run_at', { fsp: 3 }).notNull(),
    payload: json('payload'),
    status: mysqlEnum('status', JOB_STATUSES).notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    lockedUntil: datetime('locked_until', { fsp: 3 }),
    uniqueKey: varchar('unique_key', { length: 191 }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('jobs_unique_key_uq').on(t.uniqueKey),
    index('jobs_status_run_at_idx').on(t.status, t.runAt),
  ],
);
