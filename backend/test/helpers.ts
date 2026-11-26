import { sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import type { AppDeps } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { users } from '../src/db/schema/index.js';
import { generatePublicId } from '../src/users/nickname.js';
import { createRedis } from '../src/redis/client.js';

export const TEST_PEPPER = 'test-pepper-0123456789abcdefghijklmnop';
/** Тестовий ключ шифрування посилань iCal (32 байти, base64). */
export const TEST_CALENDAR_IMPORT_KEY = Buffer.from('test-calendar-import-key-0123456').toString(
  'base64',
);

const pools = new WeakMap<Db, { end(): Promise<void> }>();

export async function closeDeps(deps: AppDeps): Promise<void> {
  deps.redis.disconnect();
  await pools.get(deps.db)?.end();
}

export async function testDeps(extraEnv: Record<string, string> = {}): Promise<AppDeps> {
  const dbUrl = process.env.DATABASE_URL_TEST;
  if (!dbUrl) throw new Error('DATABASE_URL_TEST is required for tests');
  const base = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisUrl = `${base.replace(/\/\d+$/, '')}/${process.env.TEST_REDIS_DB ?? '15'}`;
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    REALTIME_ADAPTER_KEY: process.env.REALTIME_ADAPTER_KEY,
    IDENTITY_PEPPER: TEST_PEPPER,
    INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
    CALENDAR_IMPORT_KEY: TEST_CALENDAR_IMPORT_KEY,
    ...extraEnv,
  });
  const { db, pool } = createDb(dbUrl);
  pools.set(db, pool);
  const redis = createRedis(redisUrl);
  return { env, db, redis };
}

const TABLES = [
  'calendar_import_busy',
  'calendar_imports',
  'rsvp_decline_notices',
  'calendar_reminders',
  'poll_votes',
  'poll_options',
  'polls',
  'demo_entities',
  'moderation_digest_log',
  'moderation_log',
  'sanction_appeals',
  'complaints',
  'sanctions',
  'rating_reminder_log',
  'published_ratings',
  'ratings',
  'entity_views',
  'telegram_outbox',
  'reminder_log',
  'notifications',
  'notification_prefs',
  'calendar_pinned_games',
  'user_settings',
  'notes',
  'session_rsvp',
  'session_attendance',
  'game_sessions',
  'application_constraint_responses',
  'game_applications',
  'gm_blacklist',
  'game_bans',
  'game_members',
  'game_content_warnings',
  'game_staleness_log',
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

/** Один запит: які з таблиць `TABLES` зараз не порожні. */
const NON_EMPTY = sql.raw(
  TABLES.map((t) => `SELECT '${t}' AS t FROM DUAL WHERE EXISTS (SELECT 1 FROM \`${t}\`)`).join(
    ' UNION ALL ',
  ),
);

/**
 * Очищує тестову БД між тестами. `TRUNCATE` усіх таблиць коштував ~1.2 с на тест (InnoDB
 * перестворює кожну таблицю), тож чистимо лише непорожні таблиці через `DELETE` і скидаємо
 * їм `AUTO_INCREMENT` (тести можуть розраховувати на id з 1) — ~30 мс.
 */
export async function resetDb(db: Db): Promise<void> {
  // Одна транзакція = одне з'єднання, тож SET FOREIGN_KEY_CHECKS діє на всі запити.
  await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(NON_EMPTY)) as unknown as [{ t: string }[]];
    if (rows.length === 0) return;
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const { t } of rows) {
        await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
        await tx.execute(sql.raw(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1`));
      }
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
