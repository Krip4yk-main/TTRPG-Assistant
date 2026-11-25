import { asc, eq } from 'drizzle-orm';
import {
  adminCatalogSystemCreateSchema,
  adminCatalogSystemPatchSchema,
  type AdminCatalogSystemDto,
  type CatalogDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { isDuplicateKey } from '../db/errors.js';
import { contentWarnings, gameSystems, genres } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { writeLog } from '../moderation/log.js';
import { assertCan } from '../moderation/permissions.js';
import { actorRole } from '../moderation/sanctions.service.js';

export const CATALOG_CACHE_KEY = 'catalog:v1';
/**
 * 5 хвилин: адмінські зміни скидають кеш (`invalidateCatalog`), але паралельний читач, що
 * прочитав БД до коміту зміни, може записати старий каталог уже після скидання — короткий TTL
 * обмежує таку застарілість.
 */
const CATALOG_TTL_SECONDS = 5 * 60;

async function loadCatalog(deps: AppDeps): Promise<CatalogDto> {
  const { db } = deps;
  const [systems, genreRows, warnings] = await Promise.all([
    db.select().from(gameSystems).orderBy(asc(gameSystems.sort), asc(gameSystems.id)),
    db.select().from(genres).orderBy(asc(genres.sort), asc(genres.id)),
    db.select().from(contentWarnings).orderBy(asc(contentWarnings.sort), asc(contentWarnings.id)),
  ]);
  return {
    // Вимкнені системи не пропонуються в нових іграх; наявні ігри беруть назву через join.
    systems: systems
      .filter((s) => s.isActive)
      .map((s) => ({ id: s.id, slug: s.slug, name: s.name, defaultGenreId: s.defaultGenreId })),
    genres: genreRows.map((g) => ({ id: g.id, slug: g.slug })),
    contentWarnings: warnings.map((w) => ({ id: w.id, slug: w.slug })),
  };
}

/** Кеш на 5 хвилин; адмінські зміни каталогу скидають його (`invalidateCatalog`). */
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

/** Скидає кеш публічного каталогу після зміни (після коміту транзакції). */
export async function invalidateCatalog(deps: Pick<AppDeps, 'redis'>): Promise<void> {
  try {
    await deps.redis.del(CATALOG_CACHE_KEY);
  } catch (err) {
    // Застарілий запис (якщо Redis «ожив») зникне за TTL.
    console.error('[catalog] cache invalidation failed', (err as Error).message);
  }
}

type SystemRow = typeof gameSystems.$inferSelect;

const toAdminDto = (s: SystemRow): AdminCatalogSystemDto => ({
  id: s.id,
  slug: s.slug,
  name: s.name,
  defaultGenreId: s.defaultGenreId,
  sort: s.sort,
  isActive: s.isActive,
});

const snapshot = (s: SystemRow) => ({
  name: s.name,
  defaultGenreId: s.defaultGenreId,
  sort: s.sort,
  isActive: s.isActive,
});

async function assertGenre(db: Db | Tx, id: number): Promise<void> {
  const [g] = await db.select({ id: genres.id }).from(genres).where(eq(genres.id, id));
  if (!g) throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_GENRE' });
}

/** Роль — з БД (не з кешу сесії): зниження ролі діє одразу. */
async function assertCatalogEditor(db: Db | Tx, actorId: number): Promise<void> {
  assertCan(await actorRole(db, actorId), 'catalog.edit');
}

/** `GET /api/admin/catalog/systems` (адмін+): усі системи, зокрема вимкнені. */
export async function listAdminSystems(
  deps: Pick<AppDeps, 'db'>,
  actorId: number,
): Promise<{ items: AdminCatalogSystemDto[] }> {
  await assertCatalogEditor(deps.db, actorId);
  const rows = await deps.db
    .select()
    .from(gameSystems)
    .orderBy(asc(gameSystems.sort), asc(gameSystems.id));
  return { items: rows.map(toAdminDto) };
}

/** `POST /api/admin/catalog/systems` (адмін+); дубль slug → 409 `CATALOG_SLUG_TAKEN`. */
export async function createAdminSystem(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  actorId: number,
  body: unknown,
): Promise<AdminCatalogSystemDto> {
  const input = adminCatalogSystemCreateSchema.parse(body ?? {});
  let row: SystemRow;
  try {
    row = await deps.db.transaction(async (tx) => {
      await assertCatalogEditor(tx, actorId);
      await assertGenre(tx, input.defaultGenreId);
      const [res] = await tx.insert(gameSystems).values(input).$returningId();
      const [created] = await tx.select().from(gameSystems).where(eq(gameSystems.id, res!.id));
      await writeLog(tx, {
        actorId,
        action: 'catalog.system_create',
        targetType: 'game_system',
        targetId: created!.id,
        meta: { slug: created!.slug, after: snapshot(created!) },
      });
      return created!;
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'CATALOG_SLUG_TAKEN');
    throw err;
  }
  await invalidateCatalog(deps);
  return toAdminDto(row);
}

/** `PATCH /api/admin/catalog/systems/:id` (адмін+): назва, жанр, порядок, увімкнено; slug незмінний. */
export async function patchAdminSystem(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  actorId: number,
  id: number,
  body: unknown,
): Promise<AdminCatalogSystemDto> {
  const patch = adminCatalogSystemPatchSchema.parse(body ?? {});
  const row = await deps.db.transaction(async (tx) => {
    await assertCatalogEditor(tx, actorId);
    const [prev] = await tx.select().from(gameSystems).where(eq(gameSystems.id, id)).for('update');
    if (!prev) throw new AppError(404, 'NOT_FOUND');
    if (patch.defaultGenreId !== undefined) await assertGenre(tx, patch.defaultGenreId);
    await tx.update(gameSystems).set(patch).where(eq(gameSystems.id, id));
    const [next] = await tx.select().from(gameSystems).where(eq(gameSystems.id, id));
    await writeLog(tx, {
      actorId,
      action: 'catalog.system_update',
      targetType: 'game_system',
      targetId: id,
      meta: { slug: prev.slug, before: snapshot(prev), after: snapshot(next!) },
    });
    return next!;
  });
  await invalidateCatalog(deps);
  return toAdminDto(row);
}
