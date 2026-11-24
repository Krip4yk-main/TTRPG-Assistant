import { sql } from 'drizzle-orm';
import {
  bigint,
  datetime,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import type { NoteScope } from '@nri/shared';
import { games } from './games.js';
import { gameSessions } from './sessions.js';
import { users } from './users.js';

const NOTE_SCOPES = [
  'game_shared',
  'game_private',
  'session_private',
] as const satisfies NoteScope[];

const id = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/**
 * Нотатки: одна на (scope, гра, сесія, автор). `session_key` = `IFNULL(session_id, 0)`,
 * бо NULL у UNIQUE не конфліктує (VIRTUAL — через CASCADE-FK на `session_id`).
 * `body` — mediumtext (≤ 200 000 символів кирилиці ≈ 400 КБ).
 */
export const notes = mysqlTable(
  'notes',
  {
    id: id('id').autoincrement().primaryKey(),
    scope: mysqlEnum('scope', NOTE_SCOPES).notNull(),
    gameId: id('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    sessionId: id('session_id').references(() => gameSessions.id, { onDelete: 'cascade' }),
    sessionKey: bigint('session_key', { mode: 'number', unsigned: true }).generatedAlwaysAs(
      sql`IFNULL(session_id, 0)`,
      { mode: 'virtual' },
    ),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: mediumtext('body').notNull(),
    /** Оптимістична конкуренція: PUT з `version` ≠ поточній → 409 `NOTE_CONFLICT`. */
    version: int('version').notNull().default(1),
    updatedAt: datetime('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('notes_scope_game_session_user_uq').on(t.scope, t.gameId, t.sessionKey, t.userId),
    index('notes_game_id_idx').on(t.gameId),
    index('notes_user_id_idx').on(t.userId),
  ],
);
