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
  PauseReason,
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
const AGE_RATINGS = ['none', '16+', '18+', '21+'] as const satisfies AgeRating[];
const GAME_EXPERIENCE = ['any', 'beginner', 'experienced'] as const satisfies GameExperience[];
const GAME_LANGUAGES = ['uk', 'en'] as const satisfies GameLanguage[];
const GAME_STATUSES = [
  'draft',
  'recruiting',
  'started',
  'paused',
  'finished',
  'cancelled',
] as const satisfies GameStatus[];
const PAUSE_REASONS = [
  'vacation',
  'illness',
  'study_work',
  'other',
] as const satisfies PauseReason[];

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
    startsAt: datetime('starts_at'),
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
    // Пауза кампейну (План 11): заповнені лише в статусі `paused`, відновлення їх очищує.
    pausedAt: datetime('paused_at'),
    pauseReason: mysqlEnum('pause_reason', PAUSE_REASONS),
    pauseNote: varchar('pause_note', { length: 300 }),
    /** Останнє відновлення з паузи: від нього теж рахується давність гри (детектор «мертвих»). */
    resumedAt: datetime('resumed_at'),
    /**
     * Останнє нагадування майстру про довгу паузу (`game.long_pause`): після 90 днів паузи —
     * не частіше ніж раз на 30 днів. Раніше за `paused_at` — з попередньої паузи, не рахується.
     */
    longPauseRemindedAt: datetime('long_pause_reminded_at'),
    // «Мертві» ігри (План 7, `games/dead-games`): стан перераховує щоденний детектор.
    /** Позначено «мертвою» (> 90 днів без проведеної сесії): прихована з пошуку й sitemap. */
    deadAt: datetime('dead_at'),
    /** «Все ок» від майстра: до цього моменту гра не нагадується й не позначається. */
    deadSnoozedUntil: datetime('dead_snoozed_until'),
    /** Адмін зняв позначку «мертва»: гра звільнена від перевірки до наступної проведеної сесії. */
    deadExemptUntilSession: boolean('dead_exempt_until_session').notNull().default(false),
    /** Позначено «підозрілою» (накладання сесій з іншою грою майстра). */
    suspiciousAt: datetime('suspicious_at'),
    /** Адмін зняв позначку «підозріла»: до цього моменту вона не повертається. */
    suspiciousDismissedUntil: datetime('suspicious_dismissed_until'),
    /** Гру закрила адміністрація (з вкладки «Мертві ігри»). */
    closedByAdmin: boolean('closed_by_admin').notNull().default(false),
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
    index('games_dead_at_idx').on(t.deadAt),
    index('games_suspicious_at_idx').on(t.suspiciousAt),
  ],
);

const STALENESS_KINDS = ['stale_reminder', 'dead', 'suspicious'] as const;

/**
 * Журнал сповіщень детектора «мертвих» ігор: UNIQUE(гра, вид, період) не дає повторному чи
 * паралельному прогону надіслати те саме сповіщення двічі. `period_key` — епізод (див.
 * `games/dead-games/detector.ts`).
 */
export const gameStalenessLog = mysqlTable(
  'game_staleness_log',
  {
    id: id('id').autoincrement().primaryKey(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    kind: mysqlEnum('kind', STALENESS_KINDS).notNull(),
    periodKey: varchar('period_key', { length: 64 }).notNull(),
    createdAt: datetime('created_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex('game_staleness_log_uq').on(t.gameId, t.kind, t.periodKey)],
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
  'banned_by_admin',
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
    // Мілісекунди: виходи порівнюються з `done_at` і «зараз» (права й запрошення оцінити) —
    // без округлення MySQL до секунди щойно записаний вихід не опиняється «в майбутньому».
    joinedAt: datetime('joined_at', { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    leftAt: datetime('left_at', { fsp: 3 }),
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
