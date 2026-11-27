import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  /** Незмінний публічний ідентифікатор (URL профілю `/users/<publicId>`). */
  publicId: char('public_id', { length: 10 }).notNull().unique(),
  nickname: varchar('nickname', { length: 32 }).unique(),
  /** Ефективний аватар (обчислюється з `avatarSource`, див. `users/avatar.ts`); його читають усі споживачі. */
  avatarUrl: varchar('avatar_url', { length: 512 }),
  /** Обране джерело аватара; `auto` — аватар провайдера, з яким створено акаунт. */
  avatarSource: mysqlEnum('avatar_source', [
    'auto',
    'google',
    'discord',
    'telegram',
    'custom',
    'none',
  ])
    .notNull()
    .default('auto'),
  /** Власне посилання на аватар (використовується за `avatarSource = custom`). */
  customAvatarUrl: varchar('custom_avatar_url', { length: 512 }),
  birthDate: date('birth_date', { mode: 'string' }),
  birthDateChangedAt: datetime('birth_date_changed_at'),
  role: mysqlEnum('role', ['owner', 'admin', 'moderator', 'user']).notNull().default('user'),
  status: mysqlEnum('status', ['pending', 'active', 'deleted']).notNull().default('pending'),
  isBanned: boolean('is_banned').notNull().default(false),
  /** Лічильник періодів бану (кожен новий бан — `+1`). */
  banEpoch: int('ban_epoch').notNull().default(0),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Kyiv'),
  locale: varchar('locale', { length: 8 }).notNull().default('uk'),
  /** Обраний дизайн сайту (`ThemeId`); NULL — дефолт. Ефективне значення — `resolveTheme`. */
  uiTheme: varchar('ui_theme', { length: 32 }),
  /** Налаштування вигляду дизайну «Дошка»: анімація відривання оголошення (за замовчуванням — так). */
  qbTearAnimation: boolean('qb_tear_animation').notNull().default(true),
  /** Налаштування вигляду дизайну «Магіпанк»: заявка відлітає в конверті (за замовчуванням — так). */
  uiSendAnimation: boolean('ui_send_animation').notNull().default(true),
  /** Приватні «Мої межі» (масив рядків); віддаються лише власнику через `MeDto`. */
  myLimits: json('my_limits')
    .$type<string[]>()
    .notNull()
    .default(sql`(json_array())`),
  privacy: json('privacy')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`(json_object())`),
  createdAt: datetime('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => new Date()),
  deletedAt: datetime('deleted_at'),
});
