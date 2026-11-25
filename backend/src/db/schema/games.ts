import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type {
  AgeRating,
  ChannelLink,
  GameExperience,
  GameFormat,
  GameKind,
  GameLanguage,
  GameStatus,
  MemberLeftReason,
  MemberRole,
  Recurrence,
  Weekday,
} from '@nri/shared';
import { contentWarnings, gameSystems, genres } from './catalog.js';
import { users } from './users.js';

// drizzle-kit не вміє вантажити ESM-пакет @nri/shared, тож значення enum-ів — тут,
// а збіг із контрактом перевіряє `satisfies`.
const GAME_FORMATS = ['online', 'offline'] as const satisfies GameFormat[];
const GAME_KINDS = ['oneshot', 'campaign'] as const satisfies GameKind[];
const RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly'] as const satisfies Recurrence[];
const AGE_RATINGS = ['none', '18+', '21+'] as const satisfies AgeRating[];
const GAME_EXPERIENCE = ['any', 'beginner', 'experienced'] as const satisfies GameExperience[];
const GAME_LANGUAGES = ['uk', 'en'] as const satisfies GameLanguage[];
const GAME_STATUSES = [
  'draft',
  'recruiting',
  'started',
  'finished',
  'cancelled',
] as const satisfies GameStatus[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

export const games = mysqlTable(
  'games',
  {
    id: id('id').autoincrement().primaryKey(),
    gmUserId: id('gm_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 120 }).notNull(),
    description: text('description').notNull(),
    /** Рівно одне з `systemId` / `systemOther` (перевіряє `gameInputSchema`). */
    systemId: id('system_id').references(() => gameSystems.id),
    systemOther: varchar('system_other', { length: 80 }),
    genreId: id('genre_id')
      .notNull()
      .references(() => genres.id),
    format: mysqlEnum('format', GAME_FORMATS).notNull(),
    city: varchar('city', { length: 80 }),
    address: varchar('address', { length: 255 }),
    platform: varchar('platform', { length: 60 }),
    kind: mysqlEnum('kind', GAME_KINDS).notNull(),
    startsAt: datetime('starts_at').notNull(),
    durationMinutes: smallint('duration_minutes').notNull(),
    recurrence: mysqlEnum('recurrence', RECURRENCES).notNull().default('none'),
    weekdays: json('weekdays')
      .$type<Weekday[]>()
      .notNull()
      .default(sql`(json_array())`),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    minPlayers: tinyint('min_players').notNull(),
    maxPlayers: tinyint('max_players').notNull(),
    priceUah: int('price_uah'),
    ageRating: mysqlEnum('age_rating', AGE_RATINGS).notNull().default('none'),
    experience: mysqlEnum('experience', GAME_EXPERIENCE).notNull().default('any'),
    language: mysqlEnum('language', GAME_LANGUAGES).notNull().default('uk'),
    requirements: text('requirements'),
    coverUrl: varchar('cover_url', { length: 512 }),
    channelLinks: json('channel_links')
      .$type<ChannelLink[]>()
      .notNull()
      .default(sql`(json_array())`),
    applicationQuestions: json('application_questions')
      .$type<string[]>()
      .notNull()
      .default(sql`(json_array())`),
    customWarnings: json('custom_warnings')
      .$type<string[]>()
      .notNull()
      .default(sql`(json_array())`),
    status: mysqlEnum('status', GAME_STATUSES).notNull().default('draft'),
    showWhenFull: boolean('show_when_full').notNull().default(false),
    publishedAt: datetime('published_at'),
    startedAt: datetime('started_at'),
    finishedAt: datetime('finished_at'),
    cancelledAt: datetime('cancelled_at'),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    /** Мілісекунди: порівнюється з `entity_views.viewed_at` (стан «оновлено»). */
    updatedAt: datetime('updated_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('games_status_starts_at_idx').on(t.status, t.startsAt),
    index('games_gm_user_id_idx').on(t.gmUserId),
  ],
);

export const gameContentWarnings = mysqlTable(
  'game_content_warnings',
  {
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    warningId: id('warning_id')
      .notNull()
      .references(() => contentWarnings.id),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.warningId] })],
);

const MEMBER_ROLES = ['player'] as const satisfies MemberRole[];
const MEMBER_LEFT_REASONS = [
  'left',
  'kicked',
  'banned',
  'account_deleted',
] as const satisfies MemberLeftReason[];

/**
 * Членства в грі (історія): активне — `left_at IS NULL`. Записи не видаляються при виході,
 * тож одна пара (гра, користувач) може мати кілька рядків, але лише один активний —
 * унікальність тримає згенерована `active` (1 або NULL; NULL-и в UNIQUE не конфліктують).
 */
export const gameMembers = mysqlTable(
  'game_members',
  {
    id: id('id').autoincrement().primaryKey(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', MEMBER_ROLES).notNull().default('player'),
    /** Заявка, з якої з'явилось членство (`game_applications.id`). */
    // FK свідомо не оголошено: applications.ts імпортує games.ts (циклічний імпорт схеми); рядки прибирають ті самі каскади гри/користувача.
    applicationId: id('application_id'),
    joinedAt: datetime('joined_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    leftAt: datetime('left_at'),
    leftReason: mysqlEnum('left_reason', MEMBER_LEFT_REASONS),
    leaveNoteGm: text('leave_note_gm'),
    leaveNoteAdmin: text('leave_note_admin'),
    active: tinyint('active').generatedAlwaysAs(sql`IF(left_at IS NULL, 1, NULL)`, {
      mode: 'stored',
    }),
  },
  (t) => [
    uniqueIndex('game_members_active_uq').on(t.gameId, t.userId, t.active),
    index('game_members_user_id_idx').on(t.userId),
  ],
);

/** Бан у конкретній грі: блокує нові заявки на неї. */
export const gameBans = mysqlTable(
  'game_bans',
  {
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.userId] })],
);

/** Чорний список майстра: блокує заявки на всі його ігри. */
export const gmBlacklist = mysqlTable(
  'gm_blacklist',
  {
    gmUserId: id('gm_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.gmUserId, t.userId] }),
    index('gm_blacklist_user_id_idx').on(t.userId),
  ],
);
