import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

describe('users.nickname collation', () => {
  it('is explicitly utf8mb4_0900_ai_ci', async () => {
    const [rows] = (await db.execute(sql`SHOW FULL COLUMNS FROM users LIKE 'nickname'`)) as unknown as [
      { Collation: string }[],
    ];
    expect(rows[0]!.Collation).toBe('utf8mb4_0900_ai_ci');
  });

  it('treats nicknames case-insensitively as duplicates', async () => {
    await createUser(db, { nickname: 'Saruman' });
    await expect(createUser(db, { nickname: 'saruman' })).rejects.toThrow(/Duplicate|Failed query/i);
  });
});
