import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authIdentities, sessions, users } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

describe('schema', () => {
  it('rejects duplicate (provider, subject)', async () => {
    const a = await createUser(db);
    const b = await createUser(db);
    await db.insert(authIdentities).values({ userId: a.id, provider: 'dev', subject: 's1' });
    await expect(
      db.insert(authIdentities).values({ userId: b.id, provider: 'dev', subject: 's1' }),
    ).rejects.toThrow(/Duplicate|Failed query/i);
  });

  it('cascades user deletion to sessions', async () => {
    const u = await createUser(db);
    const now = new Date();
    await db.insert(sessions).values({
      userId: u.id,
      tokenHash: 'a'.repeat(64),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 1000),
    });
    await db.delete(users).where(eq(users.id, u.id));
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('applies defaults and round-trips birthDate as YYYY-MM-DD', async () => {
    const u = await createUser(db, { birthDate: '2000-01-31' });
    expect(u.birthDate).toBe('2000-01-31');
    expect(u.role).toBe('user');
    expect(u.timezone).toBe('Europe/Kyiv');
    expect(u.locale).toBe('uk');
    expect(u.privacy).toEqual({});
    expect(u.isBanned).toBe(false);
    expect(u.nickname).toBeNull();
  });
});
