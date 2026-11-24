import { existsSync } from 'node:fs';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDb } from './client.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { db, pool } = createDb(url);
try {
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('migrations applied');
} finally {
  await pool.end();
}
