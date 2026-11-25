import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDb } from '../db/client.js';
import { hashSeed } from './demo/random.js';
import { DEFAULT_SEED, seedDemo } from './demo/seed.js';

interface Args {
  reset: boolean;
  scale: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string): string | undefined => {
    const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    const a = argv[i]!;
    return a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[i + 1];
  };
  const scale = Number(value('scale') ?? '1');
  if (!Number.isFinite(scale) || scale <= 0 || scale > 5)
    throw new Error('--scale must be in (0, 5]');
  const seedArg = value('seed');
  const seed =
    seedArg === undefined
      ? DEFAULT_SEED
      : /^\d+$/.test(seedArg)
        ? Number(seedArg)
        : hashSeed(seedArg);
  return { reset: argv.includes('--reset'), scale, seed };
}

/**
 * `npm run seed:demo -w backend [-- --reset] [--scale=1] [--seed=…]`: демо-дані для локальної
 * розробки (див. `demo/seed.ts`). Лише NODE_ENV=development і не тестова БД; секретів не друкує.
 */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { db, pool } = createDb(url);
  try {
    const started = Date.now();
    const res = await seedDemo(db, { ...args, log: (m) => console.log(`  ${m}`) });
    console.log(`\nseed-demo done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log('\nrows per table (whole DB):');
    for (const [t, n] of Object.entries(res.counts)) console.log(`  ${t.padEnd(34)} ${n}`);
    console.log(
      res.ratingIssues.length
        ? `\nrating snapshots: ${res.ratingIssues.length} ISSUES ${JSON.stringify(res.ratingIssues.slice(0, 5))}`
        : '\nrating snapshots: consistent',
    );
    if (res.ownerId !== null) console.log(`owner games: ${res.ownerGameIds.length}`);
    console.log('\naccounts to try (dev-login by nickname):');
    for (const a of res.accounts) console.log(`  ${a.nickname.padEnd(28)} ${a.label}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`seed-demo: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
