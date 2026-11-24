import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { schema } from './schema/index.js';

export type Db = MySql2Database<typeof schema>;

export function createDb(url: string): { db: Db; pool: Pool } {
  // dateStrings: DATE-колонки (birthDate) лишаються рядками 'YYYY-MM-DD'; datetime drizzle парсить як UTC.
  const pool = mysql.createPool({ uri: url, timezone: 'Z', dateStrings: ['DATE'] });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}
