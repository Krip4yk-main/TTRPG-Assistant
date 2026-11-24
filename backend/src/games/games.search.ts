import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  availabilityFit,
  expandOccurrences,
  FIT_HORIZON_DAYS,
  isRestrictedGame,
  SEARCH_SORTS,
  searchFiltersSchema,
  type AvailabilityDto,
  type SearchFilters,
  type SearchGameCardDto,
  type SearchResultDto,
  type SearchSort,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { SessionUser } from '../auth/session.service.js';
import { getAvailability } from '../availability/availability.service.js';
import { gameContentWarnings, gameMembers, games } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { loadGames, resolveViewer, toCardDto, type Loaded } from './games.service.js';
import { toCardView } from './games.visibility.js';

const DAY_MS = 86_400_000;
/** Кандидатів за один SQL-запит, коли діє фільтр у пам'яті (календар/дати). */
const BATCH = 200;
/** Скільки кандидатів максимум переглядає один запит; далі — сторінка з курсором. */
const MAX_SCAN = 1000;
/** Верхня межа розгортання розкладу, коли задано лише `dateFrom`. */
const DATE_ONLY_FROM_SPAN_MS = 366 * DAY_MS;

// ---------- курсор ----------

/**
 * Курсор — base64url JSON `{ s, k, id }`: сортування, ключ сортування останнього
 * виданого рядка (ISO) та його id. Курсор іншого сортування чи сміття → 400.
 */
const cursorSchema = z
  .object({ s: z.enum(SEARCH_SORTS), k: z.iso.datetime(), id: z.number().int().positive() })
  .strict();
type Cursor = z.output<typeof cursorSchema>;

function sortKey(row: Loaded['row'], sort: SearchSort): Date {
  // Видимі ігри (recruiting/started) завжди опубліковані — `published_at` не NULL.
  return sort === 'soonest' ? row.startsAt : row.publishedAt!;
}

function encodeCursor(row: Loaded['row'], sort: SearchSort): string {
  const c: Cursor = { s: sort, k: sortKey(row, sort).toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string, sort: SearchSort): Cursor {
  const invalid = () => new AppError(400, 'VALIDATION', { reason: 'INVALID_CURSOR' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const c = cursorSchema.safeParse(parsed);
  if (!c.success || c.data.s !== sort) throw invalid();
  return c.data;
}

/**
 * Порядок і умова «після курсора». `soonest` — за датою ПЕРШОЇ сесії (`starts_at`), а не
 * за `nextSessionAt`: так порядок стабільний у SQL і курсор не «пливе» з часом; для
 * кампаній, що вже йдуть, перша сесія в минулому, тож вони стоять на початку.
 * `newest` — за `published_at` спадно. Нічиї — за id у тому ж напрямку.
 */
function ordering(sort: SearchSort) {
  if (sort === 'soonest') {
    return {
      order: [asc(games.startsAt), asc(games.id)],
      after: (c: { k: Date; id: number }) =>
        or(gt(games.startsAt, c.k), and(eq(games.startsAt, c.k), gt(games.id, c.id))),
    };
  }
  return {
    order: [desc(games.publishedAt), desc(games.id)],
    after: (c: { k: Date; id: number }) =>
      or(lt(games.publishedAt, c.k), and(eq(games.publishedAt, c.k), lt(games.id, c.id))),
  };
}

// ---------- фільтри ----------

const memberCount = sql`(select count(*) from ${gameMembers} where ${gameMembers.gameId} = ${games.id})`;

/** SQL-префільтр за всіма полями, крім календаря (і точної перевірки дат). */
function sqlFilters(deps: AppDeps, f: SearchFilters): SQL[] {
  const c: (SQL | undefined)[] = [
    // Видимі статуси: набір гравців; гра, що йде, — лише з show_when_full.
    or(
      eq(games.status, 'recruiting'),
      and(eq(games.status, 'started'), eq(games.showWhenFull, true)),
    ),
    isNotNull(games.publishedAt),
  ];
  if (f.systemIds?.length) c.push(inArray(games.systemId, f.systemIds));
  if (f.genreIds?.length) c.push(inArray(games.genreId, f.genreIds));
  if (f.format) c.push(eq(games.format, f.format));
  if (f.kind) c.push(eq(games.kind, f.kind));
  if (f.language) c.push(eq(games.language, f.language));
  if (f.city) c.push(sql`lower(${games.city}) = lower(${f.city})`);
  if (f.platform) c.push(sql`lower(${games.platform}) = lower(${f.platform})`);
  if (f.ageRatings?.length) c.push(inArray(games.ageRating, f.ageRatings));
  if (f.experience) c.push(inArray(games.experience, [...new Set([f.experience, 'any' as const])]));
  if (f.priceMode === 'free') {
    c.push(isNull(games.priceUah));
  } else if (f.priceMode === 'paid') {
    c.push(isNotNull(games.priceUah));
    if (f.priceMax !== undefined) c.push(lte(games.priceUah, f.priceMax));
  } else if (f.priceMax !== undefined) {
    c.push(or(isNull(games.priceUah), lte(games.priceUah, f.priceMax)));
  }
  if (f.hasFreeSlots) c.push(sql`${games.maxPlayers} > ${memberCount}`);
  if (f.excludeWarningIds?.length) {
    c.push(
      notExists(
        deps.db
          .select({ one: sql`1` })
          .from(gameContentWarnings)
          .where(
            and(
              eq(gameContentWarnings.gameId, games.id),
              inArray(gameContentWarnings.warningId, f.excludeWarningIds),
            ),
          ),
      ),
    );
  }
  // Грубий префільтр дат; точна перевірка (є сесія у вікні) — у пам'яті.
  if (f.dateTo) c.push(lt(games.startsAt, new Date(f.dateTo)));
  if (f.dateFrom) {
    c.push(or(ne(games.recurrence, 'none'), gte(games.startsAt, new Date(f.dateFrom))));
  }
  return c.filter((x): x is SQL => x !== undefined);
}

const schedule = (row: Loaded['row']) => ({
  startsAt: row.startsAt.toISOString(),
  durationMinutes: row.durationMinutes,
  recurrence: row.recurrence,
  weekdays: row.weekdays,
  timezone: row.timezone,
});

type Check = (l: Loaded) => { pass: boolean; fit?: 'full' | 'partial' };

/** Фільтр у пам'яті (дати й календар) або `null`, якщо не потрібен. */
function memoryFilter(
  f: SearchFilters,
  availability: AvailabilityDto | null,
  now: Date,
): Check | null {
  const checks: Check[] = [];
  if (f.dateFrom || f.dateTo) {
    const from = new Date(Math.max(now.getTime(), f.dateFrom ? Date.parse(f.dateFrom) : 0));
    const to = f.dateTo ? new Date(f.dateTo) : new Date(from.getTime() + DATE_ONLY_FROM_SPAN_MS);
    checks.push((l) => ({ pass: expandOccurrences(schedule(l.row), from, to).length > 0 }));
  }
  if (availability) {
    const horizon = new Date(now.getTime() + FIT_HORIZON_DAYS * DAY_MS);
    checks.push((l) => {
      const fit = availabilityFit(expandOccurrences(schedule(l.row), now, horizon), availability);
      if (fit === 'full' || (fit === 'partial' && f.calendar.includePartial)) {
        return { pass: true, fit };
      }
      return { pass: false };
    });
  }
  if (checks.length === 0) return null;
  return (l) => {
    let fit: 'full' | 'partial' | undefined;
    for (const check of checks) {
      const r = check(l);
      if (!r.pass) return { pass: false };
      fit = r.fit ?? fit;
    }
    return { pass: true, fit };
  };
}

async function calendarAvailability(
  deps: AppDeps,
  f: SearchFilters,
  user: SessionUser | undefined,
): Promise<AvailabilityDto | null> {
  switch (f.calendar.mode) {
    case 'off':
      return null;
    case 'custom':
      return f.calendar.availability!;
    case 'mine':
      if (!user) throw new AppError(401, 'UNAUTHENTICATED');
      return getAvailability(deps, user.userId);
  }
}

// ---------- пошук ----------

/**
 * Пошук ігор. Сторінка збирається так: SQL-префільтр по ключу сортування після курсора
 * (до 200 кандидатів за запит, коли є фільтр у пам'яті), потім фільтр у пам'яті; збираємо
 * `limit + 1` придатних, щоб знати, чи є наступна сторінка. Курсор — ключ останнього
 * ВИДАНОГО рядка, тож відкинуті після нього рядки на наступній сторінці переглядаються
 * знову (і знову відкидаються) — без пропусків і дублів. Якщо переглянуто `MAX_SCAN`
 * кандидатів, сторінка може бути коротшою за `limit` (навіть порожньою) з курсором на
 * останньому переглянутому рядку.
 */
export async function searchGames(
  deps: AppDeps,
  user: SessionUser | undefined,
  body: unknown,
): Promise<SearchResultDto> {
  const f = searchFiltersSchema.parse(body);
  let after: { k: Date; id: number } | null = null;
  if (f.cursor !== undefined) {
    const c = decodeCursor(f.cursor, f.sort);
    after = { k: new Date(c.k), id: c.id };
  }
  const [availability, viewer] = await Promise.all([
    calendarAvailability(deps, f, user),
    resolveViewer(deps, user),
  ]);
  const now = new Date();
  const filter = memoryFilter(f, availability, now);
  const { order, after: afterCond } = ordering(f.sort);
  const base = sqlFilters(deps, f);
  const batch = filter ? BATCH : f.limit + 1;

  const picked: { l: Loaded; fit?: 'full' | 'partial' }[] = [];
  let scanned = 0;
  let last: Loaded | null = null;
  let exhausted = false;
  while (picked.length <= f.limit && scanned < MAX_SCAN) {
    const where = and(...base, ...(after ? [afterCond(after)] : []));
    const rows = await loadGames(deps, where, order, batch);
    for (const l of rows) {
      scanned++;
      last = l;
      const r = filter ? filter(l) : { pass: true };
      if (r.pass) picked.push({ l, fit: r.fit });
      if (picked.length > f.limit) break;
    }
    if (rows.length < batch) {
      exhausted = true;
      break;
    }
    after = { k: sortKey(last!.row, f.sort), id: last!.row.id };
  }

  let nextCursor: string | null = null;
  if (picked.length > f.limit) {
    picked.length = f.limit;
    nextCursor = encodeCursor(picked.at(-1)!.l.row, f.sort);
  } else if (!exhausted && last) {
    nextCursor = encodeCursor(last.row, f.sort);
  }

  const items = picked.map(({ l, fit }) => {
    const card = toCardView(toCardDto(l, now), l.row.gmUserId, viewer, now);
    if (isRestrictedGame(card) || fit === undefined) return card;
    return { ...card, fit } satisfies SearchGameCardDto;
  });
  return { items, nextCursor };
}
