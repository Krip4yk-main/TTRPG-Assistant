import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedOwner } from '../../src/cli/seed-owner.js';
import { users } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(() => closeDeps(deps));

describe('seedOwner', () => {
  it('promotes an active user once; the second attempt throws', async () => {
    const a = await createUser(db, { nickname: 'Boss' });
    await createUser(db, { nickname: 'Other' });
    await seedOwner(db, 'Boss');
    const [row] = await db.select().from(users).where(eq(users.id, a.id));
    expect(row!.role).toBe('owner');
    await expect(seedOwner(db, 'Other')).rejects.toThrow('owner already exists');
  });

  it('refuses unknown or non-active users', async () => {
    await createUser(db, { nickname: 'Pend', status: 'pending' });
    await expect(seedOwner(db, 'Nobody')).rejects.toThrow(/not found/);
    await expect(seedOwner(db, 'Pend')).rejects.toThrow(/not active/);
  });
});
