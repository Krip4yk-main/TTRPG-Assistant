import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type {
  ComplaintReason,
  ComplaintStatus,
  SanctionAppealStatus,
  SanctionType,
} from '@nri/shared';
import { games } from './games.js';
import { users } from './users.js';

// drizzle-kit не вміє вантажити ESM-пакет @nri/shared: значення — тут, збіг — через `satisfies`.
const COMPLAINT_REASONS = [
  'scam',
  'harassment',
  'no_show',
  'agreement_violation',
  'inappropriate_content',
  'other',
] as const satisfies ComplaintReason[];
const COMPLAINT_STATUSES = ['new', 'dismissed', 'actioned'] as const satisfies ComplaintStatus[];
const SANCTION_TYPES = [
  'warning',
  'application_limit',
  'no_paid_apply',
  'no_paid_create',
  'global_ban',
] as const satisfies SanctionType[];
const APPEAL_STATUSES = [
  'pending',
  'accepted',
  'rejected',
] as const satisfies SanctionAppealStatus[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });
const createdAt = () =>
  datetime('created_at', { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);
/** Посилання на персонал/учасника, що не має зникати разом із ним (журнал): SET NULL. */
const staffRef = (name: string) => id(name).references(() => users.id, { onDelete: 'set null' });

/**
 * Скарги на людину або гру (рівно одна ціль — CHECK). FK цілей без дій (MySQL забороняє
 * CASCADE/SET NULL для колонок у CHECK); користувачі й ігри не видаляються фізично, окрім
 * `pending`-акаунтів, на які скаржитись неможливо.
 */
export const complaints = mysqlTable(
  'complaints',
  {
    id: id('id').autoincrement().primaryKey(),
    reporterId: id('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetUserId: id('target_user_id').references(() => users.id),
    targetGameId: id('target_game_id').references(() => games.id),
    reason: mysqlEnum('reason', COMPLAINT_REASONS).notNull(),
    message: varchar('message', { length: 2000 }).notNull().default(''),
    status: mysqlEnum('status', COMPLAINT_STATUSES).notNull().default('new'),
    resolvedBy: staffRef('resolved_by'),
    resolvedAt: datetime('resolved_at', { fsp: 3 }),
    sanctionId: id('sanction_id').references((): AnyMySqlColumn => sanctions.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('complaints_status_id_idx').on(t.status, t.id),
    index('complaints_target_user_id_idx').on(t.targetUserId),
    index('complaints_target_game_id_idx').on(t.targetGameId),
    check(
      'complaints_one_target_ck',
      sql`(${t.targetUserId} IS NULL) <> (${t.targetGameId} IS NULL)`,
    ),
  ],
);

/**
 * Санкції. `ends_at` NULL — назавжди; чинна, якщо `lifted_at` NULL і (`ends_at` NULL або
 * `ends_at` > now). `imposed_by`/`lifted_by` NULL — система (міграція, задача строків).
 */
export const sanctions = mysqlTable(
  'sanctions',
  {
    id: id('id').autoincrement().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', SANCTION_TYPES).notNull(),
    reason: varchar('reason', { length: 2000 }).notNull(),
    imposedBy: staffRef('imposed_by'),
    startsAt: datetime('starts_at', { fsp: 3 }).notNull(),
    endsAt: datetime('ends_at', { fsp: 3 }),
    liftedAt: datetime('lifted_at', { fsp: 3 }),
    liftedBy: staffRef('lifted_by'),
    complaintId: id('complaint_id').references((): AnyMySqlColumn => complaints.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [index('sanctions_user_type_ends_idx').on(t.userId, t.type, t.endsAt)],
);

/** Апеляції на санкції: одна на санкцію. */
export const sanctionAppeals = mysqlTable(
  'sanction_appeals',
  {
    id: id('id').autoincrement().primaryKey(),
    sanctionId: id('sanction_id')
      .notNull()
      .unique('sanction_appeals_sanction_id_uq')
      .references(() => sanctions.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    message: varchar('message', { length: 2000 }).notNull(),
    status: mysqlEnum('status', APPEAL_STATUSES).notNull().default('pending'),
    decidedBy: staffRef('decided_by'),
    decidedAt: datetime('decided_at', { fsp: 3 }),
    decisionNote: varchar('decision_note', { length: 2000 }),
    createdAt: createdAt(),
  },
  (t) => [index('sanction_appeals_status_id_idx').on(t.status, t.id)],
);

/**
 * Журнал дій адміністрації — лише додавання. `actor_id` NULL — система. `target_type` —
 * `user` | `complaint` | `sanction` | `appeal` | `rating` | `game`.
 */
export const moderationLog = mysqlTable(
  'moderation_log',
  {
    id: id('id').autoincrement().primaryKey(),
    actorId: staffRef('actor_id'),
    action: varchar('action', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetId: id('target_id').notNull(),
    reason: varchar('reason', { length: 2000 }),
    meta: json('meta').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('moderation_log_target_idx').on(t.targetType, t.targetId),
    index('moderation_log_actor_id_idx').on(t.actorId),
  ],
);

/**
 * Щоденне зведення скарг: хто й за яку київську дату (`YYYY-MM-DD`) уже отримав зведення.
 * UNIQUE(user_id, digest_date) — повторний чи паралельний прогін не дублює.
 */
export const moderationDigestLog = mysqlTable(
  'moderation_digest_log',
  {
    id: id('id').autoincrement().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    digestDate: char('digest_date', { length: 10 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('moderation_digest_log_user_date_uq').on(t.userId, t.digestDate)],
);
