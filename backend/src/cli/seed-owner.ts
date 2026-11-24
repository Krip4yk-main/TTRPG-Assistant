import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema/index.js';

/** Робить існуючого активного користувача власником; кидає Error, якщо не можна. */
export async function seedOwner(db: Db, nickname: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(users)
      .where(eq(users.nickname, nickname))
      .for('update');
    if (!target) throw new Error(`user "${nickname}" not found`);
    if (target.status !== 'active') throw new Error(`user "${nickname}" is not active`);
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'owner'));
    if (owner) throw new Error('owner already exists');
    await tx.update(users).set({ role: 'owner' }).where(eq(users.id, target.id));
    return target.id;
  });
}

function parseNickname(argv: string[]): string | null {
  const i = argv.findIndex((a) => a === '--nickname' || a.startsWith('--nickname='));
  if (i < 0) return null;
  const a = argv[i]!;
  return (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1]) ?? null;
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const nickname = parseNickname(process.argv.slice(2));
  if (!nickname) throw new Error('usage: npm run seed:owner -w backend -- --nickname <nick>');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  try {
    const id = await seedOwner(db, nickname);
    console.log(`user "${nickname}" (id ${id}) is now owner`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`seed-owner: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
