import { asc } from 'drizzle-orm';
import type { CatalogDto } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { contentWarnings, gameSystems, genres } from '../db/schema/index.js';

export const CATALOG_CACHE_KEY = 'catalog:v1';
const CATALOG_TTL_SECONDS = 60 * 60;

async function loadCatalog(deps: AppDeps): Promise<CatalogDto> {
  const { db } = deps;
  const [systems, genreRows, warnings] = await Promise.all([
    db.select().from(gameSystems).orderBy(asc(gameSystems.sort), asc(gameSystems.id)),
    db.select().from(genres).orderBy(asc(genres.sort), asc(genres.id)),
    db.select().from(contentWarnings).orderBy(asc(contentWarnings.sort), asc(contentWarnings.id)),
  ]);
  return {
    systems: systems
      .filter((s) => s.isActive)
      .map((s) => ({ id: s.id, slug: s.slug, name: s.name, defaultGenreId: s.defaultGenreId })),
    genres: genreRows.map((g) => ({ id: g.id, slug: g.slug })),
    contentWarnings: warnings.map((w) => ({ id: w.id, slug: w.slug })),
  };
}

/** Каталог змінюється лише міграціями, тож кешуємо на годину. */
export async function getCatalog(deps: AppDeps): Promise<CatalogDto> {
  try {
    const cached = await deps.redis.get(CATALOG_CACHE_KEY);
    if (cached) return JSON.parse(cached) as CatalogDto;
  } catch {
    // Кеш недоступний — читаємо з БД.
  }
  const dto = await loadCatalog(deps);
  try {
    await deps.redis.set(CATALOG_CACHE_KEY, JSON.stringify(dto), 'EX', CATALOG_TTL_SECONDS);
  } catch {
    // Не критично.
  }
  return dto;
}
