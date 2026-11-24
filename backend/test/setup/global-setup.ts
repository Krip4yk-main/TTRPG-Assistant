import { existsSync } from 'node:fs';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDb } from '../../src/db/client.js';

export default async function setup(): Promise<() => void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is required for tests');
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  await pool.end();
  return () => {};
}
