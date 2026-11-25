import { z } from 'zod';

export interface CatalogSystemDto {
  id: number;
  slug: string;
  name: string;
  defaultGenreId: number;
}

export interface CatalogGenreDto {
  id: number;
  slug: string;
}

export interface CatalogWarningDto {
  id: number;
  slug: string;
}

/** Відповідь `GET /api/catalog` (публічно). */
export interface CatalogDto {
  systems: CatalogSystemDto[];
  genres: CatalogGenreDto[];
  contentWarnings: CatalogWarningDto[];
}

/** Slug системи в каталозі: малі латинські літери, цифри, дефіс між ними. */
export const CATALOG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CATALOG_SLUG_MAX = 40;
export const CATALOG_NAME_MAX = 80;

const catalogId = z.number().int().positive();
const catalogName = z.string().trim().min(1).max(CATALOG_NAME_MAX);
const catalogSort = z.number().int().min(-1_000_000).max(1_000_000);

/** Система в адмінці (`GET /api/admin/catalog/systems`): усі, зокрема вимкнені. */
export interface AdminCatalogSystemDto extends CatalogSystemDto {
  sort: number;
  isActive: boolean;
}

/** `POST /api/admin/catalog/systems` (адмін+). */
export const adminCatalogSystemCreateSchema = z
  .object({
    name: catalogName,
    slug: z.string().trim().min(1).max(CATALOG_SLUG_MAX).regex(CATALOG_SLUG_RE),
    defaultGenreId: catalogId,
    sort: catalogSort.default(0),
  })
  .strict();
export type AdminCatalogSystemCreateInput = z.input<typeof adminCatalogSystemCreateSchema>;

/** `PATCH /api/admin/catalog/systems/:id` (адмін+): slug незмінний. */
export const adminCatalogSystemPatchSchema = z
  .object({
    name: catalogName.optional(),
    defaultGenreId: catalogId.optional(),
    sort: catalogSort.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'empty patch' });
export type AdminCatalogSystemPatchInput = z.input<typeof adminCatalogSystemPatchSchema>;
