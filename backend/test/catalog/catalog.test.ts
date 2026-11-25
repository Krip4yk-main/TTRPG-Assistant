import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import type { CatalogDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { CATALOG_CACHE_KEY } from '../../src/catalog/catalog.service.js';
import { closeDeps, testDeps } from '../helpers.js';
import { readFileSync } from 'node:fs';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);

beforeEach(async () => {
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

describe('GET /api/catalog', () => {
  it('returns 14 systems incl. uesrpg, 11 genres, 10 warnings, each system with defaultGenreId', async () => {
    const res = await request(app).get('/api/catalog');
    expect(res.status).toBe(200);
    const dto = res.body as CatalogDto;
    expect(dto.systems).toHaveLength(14);
    expect(dto.genres).toHaveLength(11);
    expect(dto.contentWarnings).toHaveLength(10);
    expect(dto.systems.map((s) => s.slug)).toContain('uesrpg');
    const genreIds = new Set(dto.genres.map((g) => g.id));
    for (const s of dto.systems) expect(genreIds.has(s.defaultGenreId)).toBe(true);
  });

  it('maps default genres and display names', async () => {
    const dto = (await request(app).get('/api/catalog')).body as CatalogDto;
    const genreSlug = new Map(dto.genres.map((g) => [g.id, g.slug]));
    const def = (slug: string) =>
      genreSlug.get(dto.systems.find((s) => s.slug === slug)!.defaultGenreId);
    expect(def('wfrp4e')).toBe('dark-fantasy');
    expect(def('coc7e')).toBe('horror');
    expect(def('shadowrun6e')).toBe('cyberpunk');
    expect(def('mothership')).toBe('scifi');
    expect(def('dnd5e-2014')).toBe('fantasy');
    expect(dto.systems.find((s) => s.slug === 'uesrpg')!.name).toBe('UESRPG (The Elder Scrolls)');
    expect(dto.systems.find((s) => s.slug === 'dnd5e-2024')!.name).toBe('D&D 5e (2024)');
  });

  it('caches the response in Redis for 5 minutes', async () => {
    await request(app).get('/api/catalog');
    expect(await redis.get(CATALOG_CACHE_KEY)).not.toBeNull();
    expect(CATALOG_CACHE_KEY).toBe('catalog:v1');
    const ttl = await redis.ttl(CATALOG_CACHE_KEY);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('is public (no session needed)', async () => {
    expect((await request(app).get('/api/catalog')).status).toBe(200);
  });
});

describe('seed migration', () => {
  it('is idempotent: re-running the seed SQL does not duplicate rows', async () => {
    const seed = readFileSync('src/db/migrations/0005_catalog_seed.sql', 'utf8');
    for (const stmt of seed.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
    const count = async (t: string) => {
      const [rows] = (await db.execute(
        sql.raw(`SELECT COUNT(*) AS c FROM \`${t}\``),
      )) as unknown as [{ c: number }[]];
      return Number(rows[0]!.c);
    };
    expect(await count('game_systems')).toBe(14);
    expect(await count('genres')).toBe(11);
    expect(await count('content_warnings')).toBe(10);
  });
});
