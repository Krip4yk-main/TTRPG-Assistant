import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { users } from './users.js';

const providers = ['telegram', 'google', 'discord', 'dev'] as const;
const userId = () =>
  bigint('user_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const authIdentities = mysqlTable(
  'auth_identities',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    userId: userId(),
    provider: mysqlEnum('provider', providers).notNull(),
    subject: varchar('subject', { length: 191 }).notNull(),
    displayName: varchar('display_name', { length: 191 }),
    /** Аватар від провайдера; оновлюється при кожному вході/прив'язці (NULL — немає). */
    avatarUrl: varchar('avatar_url', { length: 512 }),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_uq').on(t.provider, t.subject),
    uniqueIndex('auth_identities_user_provider_uq').on(t.userId, t.provider),
  ],
);

export const sessions = mysqlTable(
  'sessions',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    userId: userId(),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: datetime('last_seen_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: datetime('expires_at').notNull(),
    userAgent: varchar('user_agent', { length: 255 }),
    ip: varchar('ip', { length: 45 }),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const identityTombstones = mysqlTable(
  'identity_tombstones',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    provider: mysqlEnum('provider', providers).notNull(),
    subjectHash: char('subject_hash', { length: 64 }).notNull(),
    /** Чий це був спосіб входу (бан позначає всі надгробки користувача); NULL — невідомо. */
    userId: bigint('user_id', { mode: 'number', unsigned: true }).references(() => users.id, {
      onDelete: 'set null',
    }),
    isBanned: boolean('is_banned').notNull().default(false),
    createdAt: datetime('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex('identity_tombstones_provider_hash_uq').on(t.provider, t.subjectHash),
    index('identity_tombstones_user_id_idx').on(t.userId),
  ],
);
