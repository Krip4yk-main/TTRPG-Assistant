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
