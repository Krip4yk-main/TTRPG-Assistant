import { sql } from 'drizzle-orm';
import { bigint, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import type { ExperienceLevel, PreferredFormat, ProfilePrivacyKey } from '@nri/shared';
import { users } from './users.js';

export const userProfiles = mysqlTable('user_profiles', {
  userId: bigint('user_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  bio: text('bio'),
  city: varchar('city', { length: 80 }),
  favoriteSystemIds: json('favorite_system_ids')
    .$type<number[]>()
    .notNull()
    .default(sql`(json_array())`),
  preferredFormats: json('preferred_formats')
    .$type<PreferredFormat[]>()
    .notNull()
    .default(sql`(json_array())`),
  experience: mysqlEnum('experience', [
    'none',
    'beginner',
    'intermediate',
    'veteran',
  ]).$type<ExperienceLevel>(),
  privacy: json('privacy')
    .$type<Partial<Record<ProfilePrivacyKey, boolean>>>()
    .notNull()
    .default(sql`(json_object())`),
});
