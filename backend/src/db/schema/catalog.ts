import { bigint, boolean, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const genres = mysqlTable('genres', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  sort: int('sort').notNull().default(0),
});

export const gameSystems = mysqlTable('game_systems', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 80 }).notNull(),
  defaultGenreId: bigint('default_genre_id', { mode: 'number', unsigned: true })
    .notNull()
    .references(() => genres.id),
  sort: int('sort').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

export const contentWarnings = mysqlTable('content_warnings', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  slug: varchar('slug', { length: 40 }).notNull().unique(),
  sort: int('sort').notNull().default(0),
});
