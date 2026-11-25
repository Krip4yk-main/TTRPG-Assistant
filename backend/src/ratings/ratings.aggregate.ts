import {
  RATING_MIN_UNITS,
  type PublishedRatingDto,
  type RatingCriterion,
  type UserRatingsDto,
} from '@nri/shared';
import type { PublishedCriterion } from '../db/schema/index.js';

/** Одна не-відмова: `overall` обов'язкова, критерії — за бажанням. */
export interface AggregateRow {
  raterId: number;
  gameId: number;
  overall: number;
  criteria: Partial<Record<RatingCriterion, number>> | null;
}

export interface ComputedRating {
  /** Середнє одиниць (2 знаки); `null` — одиниць немає. */
  overall: number | null;
  overallUnits: number;
  criteria: Partial<Record<RatingCriterion, PublishedCriterion>>;
  units: number;
}

/** Значення в БД — 2 знаки після коми. */
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Значення в DTO — 1 знак після коми. */
export const round1 = (x: number) => Math.round(x * 10) / 10;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Агрегація (чиста функція). Одиниця = (оцінювач, гра): спершу всі оцінки одного оцінювача в
 * межах однієї гри зводяться в одне середнє (окремо для загальної й кожного критерію;
 * пропущений критерій не входить), потім рейтинг = середнє одиниць. Відмови мають бути
 * відфільтровані до виклику.
 */
export function computeRating(rows: AggregateRow[]): ComputedRating {
  const units = new Map<string, { overall: number[]; criteria: Map<RatingCriterion, number[]> }>();
  for (const r of rows) {
    const key = `${r.raterId}:${r.gameId}`;
    let u = units.get(key);
    if (!u) {
      u = { overall: [], criteria: new Map() };
      units.set(key, u);
    }
    u.overall.push(r.overall);
    for (const [k, v] of Object.entries(r.criteria ?? {}) as [RatingCriterion, number][]) {
      const list = u.criteria.get(k);
      if (list) list.push(v);
      else u.criteria.set(k, [v]);
    }
  }
  const overallUnits: number[] = [];
  const perCriterion = new Map<RatingCriterion, number[]>();
  for (const u of units.values()) {
    overallUnits.push(mean(u.overall));
    for (const [k, vs] of u.criteria) {
      const list = perCriterion.get(k);
      if (list) list.push(mean(vs));
      else perCriterion.set(k, [mean(vs)]);
    }
  }
  const criteria: ComputedRating['criteria'] = {};
  for (const [k, vs] of perCriterion) criteria[k] = { avg: round2(mean(vs)), units: vs.length };
  return {
    overall: overallUnits.length ? round2(mean(overallUnits)) : null,
    overallUnits: overallUnits.length,
    criteria,
    units: units.size,
  };
}

/** Рядок `published_ratings` (або його відсутність / заготовка). */
export interface PublishedRow {
  overall: number | null;
  units: number;
  criteria: Partial<Record<RatingCriterion, PublishedCriterion>> | null;
}

/**
 * Опублікований зріз → DTO: `null`, поки менше 5 одиниць (заготовка — теж `null`); критерії —
 * лише з ≥ 5 одиницями; 1 знак після коми. Ні оцінювачів, ні часу, ні окремих оцінок.
 */
export function toPublishedDto(row: PublishedRow | undefined | null): PublishedRatingDto | null {
  if (!row || row.overall === null || row.units < RATING_MIN_UNITS) return null;
  const criteria: PublishedRatingDto['criteria'] = {};
  for (const [k, c] of Object.entries(row.criteria ?? {}) as [
    RatingCriterion,
    PublishedCriterion,
  ][]) {
    if (c.units >= RATING_MIN_UNITS) criteria[k] = round1(c.avg);
  }
  return { overall: round1(row.overall), units: row.units, criteria };
}

/** Загальна опублікованого зрізу як у БД (2 знаки) або `null`, якщо зрізу ще немає. */
export function publishedOverall(overall: number | null, units: number | null): number | null {
  return overall === null || units === null || units < RATING_MIN_UNITS ? null : overall;
}

export const NO_RATINGS: UserRatingsDto = { gm: null, playerFromGm: null, playerFromPlayer: null };
