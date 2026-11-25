import { sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import type { AppDeps } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { users } from '../src/db/schema/index.js';
import { generatePublicId } from '../src/users/nickname.js';
import { createRedis } from '../src/redis/client.js';

export const TEST_PEPPER = 'test-pepper-0123456789abcdefghijklmnop';

const pools = new WeakMap<Db, { end(): Promise<void> }>();

export async function closeDeps(deps: AppDeps): Promise<void> {
  deps.redis.disconnect();
  await pools.get(deps.db)?.end();
}

export async function testDeps(extraEnv: Record<string, string> = {}): Promise<AppDeps> {
  const dbUrl = process.env.DATABASE_URL_TEST;
  if (!dbUrl) throw new Error('DATABASE_URL_TEST is required for tests');
  const base = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisUrl = `${base.replace(/\/\d+$/, '')}/15`;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    IDENTITY_PEPPER: TEST_PEPPER,
    INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
    ...extraEnv,
  });
  const { db, pool } = createDb(dbUrl);
  pools.set(db, pool);
  const redis = createRedis(redisUrl);
  return { env, db, redis };
}

const TABLES = [
  'telegram_outbox',
  'reminder_log',
  'notifications',
  'notification_prefs',
  'ban_appeals',
  'calendar_pinned_games',
  'user_settings',
  'notes',
  'session_attendance',
  'game_sessions',
  'application_constraint_responses',
  'game_applications',
  'gm_blacklist',
  'game_bans',
  'game_members',
  'game_content_warnings',
  'games',
  'availability_busy_dates',
  'availability_slots',
  'user_profiles',
  'events',
  'jobs',
  'identity_tombstones',
  'sessions',
  'auth_identities',
  'users',
];

export async function resetDb(db: Db): Promise<void> {
  // Одна транзакція = одне з'єднання, тож SET FOREIGN_KEY_CHECKS діє на всі TRUNCATE.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const t of TABLES) await tx.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
    } finally {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    }
  });
}

export async function createUser(
  db: Db,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<typeof users.$inferSelect> {
  const [res] = await db
    .insert(users)
    .values({ status: 'active', publicId: generatePublicId(), ...overrides })
    .$returningId();
  const [row] = await db
    .select()
    .from(users)
    .where(sql`${users.id} = ${res!.id}`);
  return row!;
}
