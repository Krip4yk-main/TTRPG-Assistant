import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/db/client.js';
import { MIGRATIONS_DIR, computeChecksums, readManifest } from '../../src/db/checksums.js';

const HOWTO = 'Згенеруйте міграцію й виконайте `npm run db:checksums -w backend`.';

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
) as Journal;
const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('незмінність застосованих міграцій', () => {
  it('журнал і SQL-файли відповідають одне одному', () => {
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(sqlFiles);
  });

  it('`when` у журналі строго зростає (drizzle застосовує лише новіші за останню застосовану)', () => {
    const whens = journal.entries.map((e) => e.when);
    whens.forEach((w, i) => {
      if (i > 0) expect(w, journal.entries[i]!.tag).toBeGreaterThan(whens[i - 1]!);
    });
  });

  it('жоден зафіксований файл не змінено й не видалено', () => {
    const current = computeChecksums();
    const manifest = readManifest();
    const removed = Object.keys(manifest).filter((n) => !(n in current));
    const changed = Object.keys(manifest).filter((n) => n in current && current[n] !== manifest[n]);
    expect({ removed, changed }, 'Застосовані міграції незмінні: додайте нову').toEqual({
      removed: [],
      changed: [],
    });
  });

  it('усі міграції внесені до checksums.json', () => {
    const manifest = readManifest();
    const missing = Object.keys(computeChecksums()).filter((n) => !(n in manifest));
    expect(missing, HOWTO).toEqual([]);
  });
});

describe('міграції на порожній БД', () => {
  const base = process.env.DATABASE_URL_TEST;
  if (!base) throw new Error('DATABASE_URL_TEST is required for tests');
  const url = new URL(base);
  // Окрема БД поряд із воркерською (`nri_test_<id>_migr`; потрапляє під GRANT `nri\_test\_%`).
  const scratch = `${url.pathname.slice(1)}_migr`;
  const scratchUrl = new URL(base);
  scratchUrl.pathname = `/${scratch}`;
  const admin = createDb(base);
  const target = createDb(scratchUrl.toString());

  const journalRows = async () => {
    const [rows] = await target.pool.query(
      'SELECT id, hash, created_at FROM `__drizzle_migrations` ORDER BY id',
    );
    return rows;
  };

  beforeAll(async () => {
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS \`${scratch}\``));
    await admin.db.execute(
      sql.raw(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`),
    );
  });

  afterAll(async () => {
    await target.pool.end();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS \`${scratch}\``));
    await admin.pool.end();
  });

  it('усі міграції застосовуються на порожній БД', async () => {
    await migrate(target.db, { migrationsFolder: MIGRATIONS_DIR });
    expect(await journalRows()).toHaveLength(journal.entries.length);
  }, 120_000);

  it('повторний запуск нічого не змінює', async () => {
    const before = await journalRows();
    await migrate(target.db, { migrationsFolder: MIGRATIONS_DIR });
    expect(await journalRows()).toEqual(before);
  }, 60_000);
});
