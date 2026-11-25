import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDb } from '../../src/db/client.js';
import { TEST_WORKERS, workerDbUrl } from './workers.js';

/** Створює й мігрує окрему БД для кожного воркера (`nri_test_1` … `nri_test_N`). */
export default async function setup(): Promise<() => void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const base = process.env.DATABASE_URL_TEST;
  if (!base) throw new Error('DATABASE_URL_TEST is required for tests');

  const admin = createDb(base);
  try {
    for (let id = 1; id <= TEST_WORKERS; id++) {
      const name = new URL(workerDbUrl(base, id)).pathname.slice(1);
      try {
        await admin.db.execute(
          sql.raw(
            `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
          ),
        );
      } catch (err) {
        throw new Error(
          `Cannot create test database ${name}. Grant the test user access to per-worker ` +
            "databases, e.g. GRANT ALL PRIVILEGES ON `nri\_test\_%`.* TO 'nri'@'%' " +
            '(see docker/mysql-init.sql).',
          { cause: err },
        );
      }
    }
  } finally {
    await admin.pool.end();
  }

  await Promise.all(
    Array.from({ length: TEST_WORKERS }, async (_, i) => {
      const { db, pool } = createDb(workerDbUrl(base, i + 1));
      try {
        await migrate(db, { migrationsFolder: 'src/db/migrations' });
      } finally {
        await pool.end();
      }
    }),
  );
  return () => {};
}
