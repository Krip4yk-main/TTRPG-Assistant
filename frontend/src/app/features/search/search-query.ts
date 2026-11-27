import type { ParamMap, Params } from '@angular/router';
import {
  AGE_RATINGS,
  GAME_EXPERIENCE,
  GAME_FORMATS,
  GAME_KINDS,
  GAME_LANGUAGES,
  MAX_DATE_WINDOW_DAYS,
  PRICE_MODES,
  SEARCH_SORTS,
  zonedToUtc,
  type AgeRating,
  type AvailabilityDto,
  type GameExperience,
  type GameFormat,
  type GameKind,
  type GameLanguage,
  type SearchFiltersInput,
  type SearchSort,
} from '@nri/shared';

export type PriceMode = (typeof PRICE_MODES)[number];
/** Режим календаря, який можна задати в URL (`custom` — лише в пам'яті сторінки). */
export type UrlCalendarMode = 'off' | 'mine';

/** Стан фільтрів пошуку, як він живе в URL. Дати — `YYYY-MM-DD` у поясі користувача. */
export interface SearchFilterState {
  systemIds: number[];
  genreIds: number[];
  format?: GameFormat;
  city?: string;
  kind?: GameKind;
  dateFrom?: string;
  dateTo?: string;
  priceMode: PriceMode;
  priceMax?: number;
  ageRatings: AgeRating[];
  experience?: GameExperience;
  platform?: string;
  language?: GameLanguage;
  hasFreeSlots: boolean;
  /** Лише ігри, де майстер зазначив інструменти безпеки, межі чи завіси. */
  hasSafetyTools: boolean;
  excludeWarningIds: number[];
  /** Не задано — типовий режим (`mine`, якщо в користувача є слоти). */
  calendar?: UrlCalendarMode;
  includePartial: boolean;
  sort: SearchSort;
}

export const EMPTY_FILTERS: SearchFilterState = {
  systemIds: [],
  genreIds: [],
  priceMode: 'any',
  ageRatings: [],
  hasFreeSlots: false,
  hasSafetyTools: false,
  excludeWarningIds: [],
  includePartial: false,
  sort: 'soonest',
};

/** Імена query-параметрів. */
const P = {
  systems: 'systems',
  genres: 'genres',
  format: 'format',
  city: 'city',
  kind: 'kind',
  from: 'from',
  to: 'to',
  price: 'price',
  priceMax: 'priceMax',
  age: 'age',
  experience: 'exp',
  platform: 'platform',
  language: 'lang',
  free: 'free',
  safety: 'safety',
  noWarnings: 'noWarn',
  calendar: 'cal',
  partial: 'partial',
  sort: 'sort',
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(values: readonly T[], v: string | null): T | undefined {
  return v !== null && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

function idList(v: string | null): number[] {
  if (!v) return [];
  const ids = v
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, 50);
}

function text(v: string | null, max: number): string | undefined {
  const t = v?.trim().slice(0, max);
  return t ? t : undefined;
}

/** `YYYY-MM-DD` справжньої дати (`2027-02-30` не «перекочується» в березень). */
function isoDate(v: string | null): string | undefined {
  if (!v || !ISO_DATE.test(v)) return undefined;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? v
    : undefined;
}

/** URL → фільтри; некоректні значення мовчки відкидаються. */
export function parseSearchParams(params: ParamMap): SearchFilterState {
  const rawPriceMax = params.get(P.priceMax)?.trim();
  const priceMax = rawPriceMax ? Number(rawPriceMax) : NaN;
  const ageRatings = (params.get(P.age) ?? '')
    .split(',')
    .map((v) => oneOf(AGE_RATINGS, v))
    .filter((v): v is AgeRating => v !== undefined);
  return {
    systemIds: idList(params.get(P.systems)),
    genreIds: idList(params.get(P.genres)),
    format: oneOf(GAME_FORMATS, params.get(P.format)),
    city: text(params.get(P.city), 80),
    kind: oneOf(GAME_KINDS, params.get(P.kind)),
    dateFrom: isoDate(params.get(P.from)),
    dateTo: isoDate(params.get(P.to)),
    priceMode: oneOf(PRICE_MODES, params.get(P.price)) ?? 'any',
    priceMax:
      Number.isInteger(priceMax) && priceMax >= 0 && priceMax <= 100_000 ? priceMax : undefined,
    ageRatings: [...new Set(ageRatings)],
    experience: oneOf(GAME_EXPERIENCE, params.get(P.experience)),
    platform: text(params.get(P.platform), 60),
    language: oneOf(GAME_LANGUAGES, params.get(P.language)),
    hasFreeSlots: params.get(P.free) === '1',
    hasSafetyTools: params.get(P.safety) === '1',
    excludeWarningIds: idList(params.get(P.noWarnings)),
    calendar: oneOf(['off', 'mine'] as const, params.get(P.calendar)),
    includePartial: params.get(P.partial) === '1',
    sort: oneOf(SEARCH_SORTS, params.get(P.sort)) ?? 'soonest',
  };
}

/** Фільтри → query-параметри (типові значення не пишуться; `null` прибирає параметр). */
export function toSearchParams(f: SearchFilterState): Params {
  const list = (xs: readonly (number | string)[]) => (xs.length ? xs.join(',') : null);
  return {
    [P.systems]: list(f.systemIds),
    [P.genres]: list(f.genreIds),
    [P.format]: f.format ?? null,
    [P.city]: f.city ?? null,
    [P.kind]: f.kind ?? null,
    [P.from]: f.dateFrom ?? null,
    [P.to]: f.dateTo ?? null,
    [P.price]: f.priceMode === 'any' ? null : f.priceMode,
    [P.priceMax]: f.priceMode === 'free' || f.priceMax === undefined ? null : f.priceMax,
    [P.age]: list(f.ageRatings),
    [P.experience]: f.experience ?? null,
    [P.platform]: f.platform ?? null,
    [P.language]: f.language ?? null,
    [P.free]: f.hasFreeSlots ? '1' : null,
    [P.safety]: f.hasSafetyTools ? '1' : null,
    [P.noWarnings]: list(f.excludeWarningIds),
    [P.calendar]: f.calendar ?? null,
    [P.partial]: f.includePartial ? '1' : null,
    [P.sort]: f.sort === 'soonest' ? null : f.sort,
  };
}

/** Чи задано хоч один фільтр (сортування й календар не рахуються). */
export function hasActiveFilters(f: SearchFilterState): boolean {
  const ignored = new Set<string>([P.sort, P.calendar, P.partial]);
  return Object.entries(toSearchParams(f)).some(([k, v]) => v !== null && !ignored.has(k));
}

/** `YYYY-MM-DD` → північ цієї дати в поясі `tz` (ISO UTC). */
function midnight(date: string, tz: string, plusDays = 0): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + plusDays));
  return zonedToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    tz,
  ).toISOString();
}

/**
 * Найдовший діапазон дат у фільтрі, діб (обидві межі включно). На добу менше за вікно
 * бекенду: перехід на літній/зимовий час може додати годину до інтервалу.
 */
export const MAX_RANGE_DAYS = MAX_DATE_WINDOW_DAYS - 1;

/** Помилка діапазону дат: кінець раніше початку або діапазон задовгий. */
export function dateRangeError(f: SearchFilterState): 'order' | 'window' | null {
  if (!f.dateFrom || !f.dateTo) return null;
  const days = Math.round((Date.parse(f.dateTo) - Date.parse(f.dateFrom)) / 86_400_000) + 1;
  if (days <= 0) return 'order';
  return days > MAX_RANGE_DAYS ? 'window' : null;
}

export type CalendarRequest =
  { mode: 'off' | 'mine' } | { mode: 'custom'; availability: AvailabilityDto };

export const SEARCH_PAGE_SIZE = 20;

/** Тіло `POST /api/games/search` без курсора. Некоректний діапазон дат не надсилається. */
export function toSearchRequest(
  f: SearchFilterState,
  calendar: CalendarRequest,
  timezone: string,
): SearchFiltersInput {
  const req: SearchFiltersInput = {
    priceMode: f.priceMode,
    sort: f.sort,
    limit: SEARCH_PAGE_SIZE,
    calendar: { ...calendar, includePartial: calendar.mode === 'off' ? false : f.includePartial },
  };
  if (f.systemIds.length) req.systemIds = f.systemIds;
  if (f.genreIds.length) req.genreIds = f.genreIds;
  if (f.format) req.format = f.format;
  if (f.city) req.city = f.city;
  if (f.kind) req.kind = f.kind;
  if (!dateRangeError(f)) {
    if (f.dateFrom) req.dateFrom = midnight(f.dateFrom, timezone);
    // Кінцева дата включно: до півночі наступного дня.
    if (f.dateTo) req.dateTo = midnight(f.dateTo, timezone, 1);
  }
  if (f.priceMax !== undefined && f.priceMode !== 'free') req.priceMax = f.priceMax;
  if (f.ageRatings.length) req.ageRatings = f.ageRatings;
  if (f.experience) req.experience = f.experience;
  if (f.platform) req.platform = f.platform;
  if (f.language) req.language = f.language;
  if (f.hasFreeSlots) req.hasFreeSlots = true;
  if (f.hasSafetyTools) req.hasSafetyTools = true;
  if (f.excludeWarningIds.length) req.excludeWarningIds = f.excludeWarningIds;
  return req;
}

/** Режим календаря, що фактично застосовано до пошуку (`null` — ще визначається). */
export type EffectiveCalendarMode = 'off' | 'mine' | 'custom' | null;

/**
 * Який календар застосувати: гість — завжди `off` (навіть з `?cal=mine`); календар «для
 * цього пошуку» має пріоритет; далі `?cal=off`; інакше — `mine`, якщо є збережені слоти.
 */
export function resolveCalendarMode(s: {
  signedIn: boolean;
  custom: boolean;
  chosen: UrlCalendarMode | undefined;
  hasSlots: boolean | null;
}): EffectiveCalendarMode {
  if (!s.signedIn) return 'off';
  if (s.custom) return 'custom';
  if (s.chosen === 'off') return 'off';
  if (s.hasSlots === null) return null;
  return s.hasSlots ? 'mine' : 'off';
}
