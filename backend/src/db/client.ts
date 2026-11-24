import { drizzle } from 'drizzle-orm/mysql2';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { schema } from './schema/index.js';

export type Db = MySql2Database<typeof schema>;

export function createDb(url: string): { db: Db; pool: Pool } {
  // dateStrings: DATE-колонки (birthDate) лишаються рядками 'YYYY-MM-DD'; datetime drizzle парсить як UTC.
  const pool = mysql.createPool({ uri: url, timezone: 'Z', dateStrings: ['DATE'] });
  // CURRENT_TIMESTAMP-дефолти йдуть за session time_zone, а не за опцією timezone клієнта.
  pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}
