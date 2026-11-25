import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { RatingCriterion, RatingKind, RatingModerationState, RatingRole } from '@nri/shared';
import { games } from './games.js';
import { gameSessions } from './sessions.js';
import { users } from './users.js';

const RATING_ROLES = ['gm', 'player_from_gm', 'player_from_player'] as const satisfies RatingRole[];
const RATING_KINDS = ['session', 'final'] as const satisfies RatingKind[];
const RATING_REMINDER_KINDS = ['deadline'] as const;
const RATING_MODERATION_STATES = [
  'none',
  'text_hidden',
  'cancelled',
] as const satisfies RatingModerationState[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/** `COALESCE(session_id, 0)`: NULL у UNIQUE не конфліктує; VIRTUAL — через CASCADE-FK на `session_id`. */
const slotKey = () =>
  bigint('slot_key', { mode: 'number', unsigned: true }).generatedAlwaysAs(
    sql`COALESCE(session_id, 0)`,
    { mode: 'virtual' },
  );

/**
 * Сирі оцінки: одна строка = оцінка або відмова (`declined`, тоді `overall`/`criteria`/`comment`
 * — NULL). `session_id` NULL — підсумкова оцінка. UNIQUE(rater, ratee, game, slot_key): одна
 * сесійна на сесію й одна підсумкова на гру. `comment` бачить лише адміністрація.
 */
export const ratings = mysqlTable(
  'ratings',
  {
    id: id('id').autoincrement().primaryKey(),
    raterId: id('rater_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rateeId: id('ratee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    sessionId: id('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
    slotKey: slotKey(),
    kind: mysqlEnum('kind', RATING_KINDS).notNull(),
    role: mysqlEnum('role', RATING_ROLES).notNull(),
    declined: boolean('declined').notNull().default(false),
    overall: tinyint('overall', { unsigned: true }),
    /** `{ критерій: 1..5 }` — лише заповнені критерії. */
    criteria: json('criteria').$type<Partial<Record<RatingCriterion, number>>>(),
    comment: varchar('comment', { length: 2000 }),
    /** Модерація: `text_hidden` — текст прихований; `cancelled` — оцінка не враховується. */
    moderated: mysqlEnum('moderated', RATING_MODERATION_STATES).notNull().default('none'),
    moderatedBy: id('moderated_by').references(() => users.id, { onDelete: 'set null' }),
    moderatedAt: datetime('moderated_at', { fsp: 3 }),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex('ratings_rater_ratee_game_slot_uq').on(t.raterId, t.rateeId, t.gameId, t.slotKey),
    index('ratings_ratee_role_id_idx').on(t.rateeId, t.role, t.id),
    index('ratings_game_id_idx').on(t.gameId),
    // Відмова — без оцінок і тексту; оцінка — з обов'язковою загальною 1..5 (`IS NOT NULL`: CHECK з NULL-результатом проходить).
    check(
      'ratings_declined_ck',
      sql`(${t.declined} = 1 AND ${t.overall} IS NULL AND ${t.criteria} IS NULL AND ${t.comment} IS NULL) OR (${t.declined} = 0 AND ${t.overall} IS NOT NULL AND ${t.overall} BETWEEN 1 AND 5)`,
    ),
  ],
);

/** Значення й кількість одиниць по критерію в опублікованому зрізі. */
export interface PublishedCriterion {
  avg: number;
  units: number;
}

/**
 * Опубліковані зрізи рейтингу на (людина, роль/джерело). Читання (профіль, картки, сортування) —
 * лише звідси. Рядок може бути заготовкою (`units` = 0, `overall` NULL) для `SELECT … FOR UPDATE`
 * при серіалізації паралельних перерахунків. `last_rating_id` — межа зрізу.
 */
export const publishedRatings = mysqlTable(
  'published_ratings',
  {
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', RATING_ROLES).notNull(),
    overall: decimal('overall', { precision: 3, scale: 2, mode: 'number' }),
    overallUnits: int('overall_units').notNull().default(0),
    criteria: json('criteria').$type<Partial<Record<RatingCriterion, PublishedCriterion>>>(),
    units: int('units').notNull().default(0),
    lastRatingId: id('last_rating_id'),
    publishedAt: datetime('published_at', { fsp: 3 }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role], name: 'published_ratings_user_role_pk' }),
    index('published_ratings_role_overall_idx').on(t.role, t.overall),
  ],
);

/**
 * Журнал нагадувань «вікно оцінювання закривається» (Task 4). UNIQUE(user, game, slot_key, kind):
 * повторний чи паралельний прогін не дублює нагадування.
 */
export const ratingReminderLog = mysqlTable(
  'rating_reminder_log',
  {
    id: id('id').autoincrement().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    sessionId: id('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
    slotKey: slotKey(),
    kind: mysqlEnum('kind', RATING_REMINDER_KINDS).notNull(),
    sentAt: datetime('sent_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [
    uniqueIndex('rating_reminder_log_user_game_slot_kind_uq').on(
      t.userId,
      t.gameId,
      t.slotKey,
      t.kind,
    ),
    index('rating_reminder_log_game_id_idx').on(t.gameId),
  ],
);
