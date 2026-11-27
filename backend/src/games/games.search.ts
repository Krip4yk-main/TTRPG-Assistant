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
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AGE_RATINGS,
  availabilityFit,
  expandOccurrences,
  FIT_HORIZON_DAYS,
  isRestrictedGame,
  meetsAgeRating,
  RATING_MIN_UNITS,
  SEARCH_SORTS,
  searchFiltersSchema,
  type AgeRating,
  type AvailabilityDto,
  type SearchFilters,
  type SearchGameCardDto,
  type SearchResultDto,
  type SearchSort,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { SessionUser } from '../auth/session.service.js';
import { getAvailability } from '../availability/availability.service.js';
import { gameBusyIntervals, type GameBusy } from '../calendar/game-busy.service.js';
import { gameContentWarnings, gameMembers, games, publishedRatings } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { importedBusyForUsers } from '../scheduling/ical/calendar-import.service.js';
import { loadGames, resolveViewer, toCardDto, type Loaded } from './games.service.js';
import { toCardView, viewerAge, type Viewer } from './games.visibility.js';

const DAY_MS = 86_400_000;
/** Кандидатів за один SQL-запит, коли діє фільтр у пам'яті (календар/дати). */
const BATCH = 200;
/** Скільки кандидатів максимум переглядає один запит; далі — сторінка з курсором. */
const MAX_SCAN = 1000;
/** Верхня межа розгортання розкладу, коли задано лише `dateFrom`. */
const DATE_ONLY_FROM_SPAN_MS = 366 * DAY_MS;

// ---------- курсор ----------

/**
 * Курсор — непрозорий токен: AES-256-GCM над JSON `{ s, r, k, id }` (сортування, ранг
 * статусу (0 — набір, 1 — гра вже йде), ключ сортування останнього виданого рядка (ISO; для
 * `gm_rating` — опублікований рейтинг майстра як у БД або `null`) та його id),
 * base64url(`iv | tag | шифротекст`).
 * Шифрування не дає вичитати `starts_at`/`published_at` прихованої (16+/18+/21+) гри.
 * Ключ — HKDF-SHA256 від `IDENTITY_PEPPER` з окремою міткою. Підроблений, сміттєвий
 * курсор чи курсор іншого сортування → 400.
 */
const cursorSchema = z
  .object({
    s: z.enum(SEARCH_SORTS),
    r: z.union([z.literal(0), z.literal(1)]),
    k: z.union([z.iso.datetime(), z.number().min(0).max(9.99), z.null()]),
    id: z.number().int().positive(),
  })
  .strict()
  .refine((c) => (c.s === 'gm_rating' ? typeof c.k !== 'string' : typeof c.k === 'string'));
type Cursor = z.output<typeof cursorSchema>;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const cursorKeys = new WeakMap<AppDeps['env'], Buffer>();

function cursorKey(deps: AppDeps): Buffer {
  let key = cursorKeys.get(deps.env);
  if (!key) {
    key = Buffer.from(
      hkdfSync('sha256', deps.env.IDENTITY_PEPPER, Buffer.alloc(0), 'nri:search-cursor', 32),
    );
    cursorKeys.set(deps.env, key);
  }
  return key;
}

type SortKey = Date | number | null;

function sortKey(l: Loaded, sort: SearchSort): SortKey {
  if (sort === 'gm_rating') return l.gmOverall;
  // Видимі ігри (recruiting/started) завжди опубліковані — `published_at` не NULL.
  return sort === 'soonest' ? l.row.startsAt : l.row.publishedAt!;
}

/** Ранг статусу: ігри, що вже йдуть (`started`), — після всіх, що набирають гравців. */
function statusRank(row: Loaded['row']): 0 | 1 {
  return row.status === 'started' ? 1 : 0;
}

type After = { r: 0 | 1; k: SortKey; id: number };

function afterOf(l: Loaded, sort: SearchSort): After {
  return { r: statusRank(l.row), k: sortKey(l, sort), id: l.row.id };
}

function encodeCursor(deps: AppDeps, l: Loaded, sort: SearchSort): string {
  const k = sortKey(l, sort);
  const c: Cursor = {
    s: sort,
    r: statusRank(l.row),
    k: k instanceof Date ? k.toISOString() : k,
    id: l.row.id,
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(deps), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(c), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

function decodeCursor(deps: AppDeps, raw: string, sort: SearchSort): Cursor {
  const invalid = () => new AppError(400, 'VALIDATION', { reason: 'INVALID_CURSOR' });
  let parsed: unknown;
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.length <= IV_BYTES + TAG_BYTES) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(deps), buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    parsed = JSON.parse(plain.toString('utf8'));
  } catch {
    throw invalid();
  }
  const c = cursorSchema.safeParse(parsed);
  if (!c.success || c.data.s !== sort) throw invalid();
  return c.data;
}

/**
 * Порядок і умова «після курсора». Першим ключем завжди йде ранг статусу: ігри, що вже
 * йдуть (`started`, видимі лише з `show_when_full`), стоять після всіх `recruiting`.
 * Далі `soonest` — за датою ПЕРШОЇ сесії (`starts_at`), а не
 * за `nextSessionAt`: так порядок стабільний у SQL і курсор не «пливе» з часом. Кампанії,
 * що вже йдуть (`started`), завдяки рангу статусу стоять у КІНЦІ списку, хоч їхня перша
 * сесія й у минулому; кампанії в наборі з першою сесією в минулому — на початку свого рангу.
 * `newest` — за `published_at` спадно. `gm_rating` — за опублікованим рейтингом майстра
 * спадно, ігри майстрів без рейтингу — після (у межах рангу статусу). Нічиї — за id у тому ж
 * напрямку (для `soonest` — зростання, для інших — спадання).
 * Порядок свідомо лишається за правилом розкладу: `nextSessionAt` у картках береться з
 * матеріалізованих сесій (перенесення/скасування враховано), тож для гри з перенесеною
 * найближчою сесією порядок і показана дата можуть трохи розходитися.
 */
const rankSql = sql<number>`(case when ${games.status} = 'started' then 1 else 0 end)`;

/**
 * Опублікований рейтинг майстра з тим самим порогом, що й ключ курсора (`publishedOverall`):
 * зріз із менш ніж `RATING_MIN_UNITS` одиницями — як «без рейтингу».
 */
const gmOverallSql = sql<
  number | null
>`(case when ${publishedRatings.units} >= ${RATING_MIN_UNITS} then ${publishedRatings.overall} end)`;

function ordering(sort: SearchSort) {
  const withRank = (within: (c: After) => SQL | undefined) => (c: After) =>
    or(sql`${rankSql} > ${c.r}`, and(sql`${rankSql} = ${c.r}`, within(c)));
  const date = (k: SortKey) => k as Date;
  if (sort === 'soonest') {
    return {
      order: [asc(rankSql), asc(games.startsAt), asc(games.id)],
      after: withRank((c) =>
        or(gt(games.startsAt, date(c.k)), and(eq(games.startsAt, date(c.k)), gt(games.id, c.id))),
      ),
    };
  }
  if (sort === 'gm_rating') {
    // `overall` — DECIMAL(3,2): ключ курсора порівнюємо як той самий тип, без похибки double.
    const k = (c: After) => sql`cast(${c.k} as decimal(3,2))`;
    return {
      order: [asc(rankSql), sql`${gmOverallSql} is null`, desc(gmOverallSql), desc(games.id)],
      after: withRank((c) =>
        c.k === null
          ? and(isNull(gmOverallSql), lt(games.id, c.id))
          : or(
              isNull(gmOverallSql),
              sql`${gmOverallSql} < ${k(c)}`,
              and(sql`${gmOverallSql} = ${k(c)}`, lt(games.id, c.id)),
            ),
      ),
    };
  }
  return {
    order: [asc(rankSql), desc(games.publishedAt), desc(games.id)],
    after: withRank((c) =>
      or(
        lt(games.publishedAt, date(c.k)),
        and(eq(games.publishedAt, date(c.k)), lt(games.id, c.id)),
      ),
    ),
  };
}

// ---------- фільтри ----------

/**
 * Гра ще «актуальна»: регулярна (кампанія з повтором) або разова, чия сесія ще попереду.
 * Разові ігри з `starts_at` у минулому не показуються в пошуку, sitemap і OG-прев'ю.
 */
export function openGamePredicate(now: Date): SQL {
  return or(ne(games.recurrence, 'none'), gt(games.startsAt, now))!;
}

/**
 * Гра в публічних списках (пошук, sitemap): актуальна й не «мертва». «Мертва» гра лишається
 * доступною за посиланням, учасникам і в профілі майстра.
 */
export function listedGamePredicate(now: Date): SQL {
  return and(openGamePredicate(now), isNull(games.deadAt))!;
}

/** Активні учасники (`left_at IS NULL`). */
const memberCount = sql`(select count(*) from ${gameMembers} where ${gameMembers.gameId} = ${games.id} and ${gameMembers.leftAt} is null)`;

/** SQL-префільтр за всіма полями, крім календаря (і точної перевірки дат). */
function sqlFilters(deps: AppDeps, f: SearchFilters, now: Date): SQL[] {
  const c: (SQL | undefined)[] = [
    // Видимі: набір гравців (повна гра — лише з show_when_full); гра, що йде, — лише з
    // show_when_full. Разова гра з початком у минулому й «мертва» гра — не видимі.
    listedGamePredicate(now),
    or(
      and(
        eq(games.status, 'recruiting'),
        or(eq(games.showWhenFull, true), sql`${games.maxPlayers} > ${memberCount}`),
      ),
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
  // Рівень X → ігри з X або `any`; `any` у фільтрі — без обмеження.
  if (f.experience && f.experience !== 'any') {
    c.push(inArray(games.experience, [f.experience, 'any']));
  }
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

/** Слоти правила гри в `[from, to)`; гра без дати старту (чернетка) — без слотів. */
const occurrences = (row: Loaded['row'], from: Date, to: Date) =>
  row.startsAt === null
    ? []
    : expandOccurrences(
        {
          startsAt: row.startsAt.toISOString(),
          durationMinutes: row.durationMinutes,
          recurrence: row.recurrence,
          weekdays: row.weekdays,
          timezone: row.timezone,
        },
        from,
        to,
      );

type Check = (l: Loaded) => { pass: boolean; fit?: 'full' | 'partial' };

/** Фільтр у пам'яті (дати й календар) або `null`, якщо не потрібен. */
function memoryFilter(
  f: SearchFilters,
  availability: AvailabilityDto | null,
  busy: GameBusy[],
  now: Date,
): Check | null {
  const checks: Check[] = [];
  if (f.dateFrom || f.dateTo) {
    const from = new Date(Math.max(now.getTime(), f.dateFrom ? Date.parse(f.dateFrom) : 0));
    const to = f.dateTo ? new Date(f.dateTo) : new Date(from.getTime() + DATE_ONLY_FROM_SPAN_MS);
    checks.push((l) => ({ pass: occurrences(l.row, from, to).length > 0 }));
  }
  if (availability) {
    const horizon = new Date(now.getTime() + FIT_HORIZON_DAYS * DAY_MS);
    checks.push((l) => {
      // Зайнятість від власних ігор глядача; сесії самої гри-кандидата її не займають.
      const own = busy.filter((b) => b.gameId !== l.row.id);
      const fit = availabilityFit(occurrences(l.row, now, horizon), availability, own);
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

/**
 * Зайнятість глядача для фільтра календаря: сесії його ігор (`gameBusyIntervals`) та
 * імпортовані з iCal інтервали (`gameId: 0` — жодна гра-кандидат їх не «звільняє»).
 */
async function viewerBusy(
  deps: AppDeps,
  userId: number,
  from: Date,
  to: Date,
): Promise<GameBusy[]> {
  const [own, imported] = await Promise.all([
    gameBusyIntervals(deps, userId, from, to, from),
    importedBusyForUsers(deps.db, [userId], from, to),
  ]);
  const ical = (imported.get(userId) ?? []).map((b) => ({
    gameId: 0,
    gameTitle: '',
    sessionId: null,
    start: b.start,
    end: b.end,
  }));
  return [...own, ...ical];
}

const RESTRICTED_RATINGS: AgeRating[] = AGE_RATINGS.filter((r) => r !== 'none');

/** Чи задано хоч один фільтр за атрибутами гри (усе, крім `ageRatings`/`sort`/`cursor`/`limit`). */
function hasDetailFilters(f: SearchFilters): boolean {
  return Boolean(
    f.systemIds?.length ||
    f.genreIds?.length ||
    f.format ||
    f.city ||
    f.kind ||
    f.dateFrom ||
    f.dateTo ||
    f.priceMode !== 'any' ||
    f.priceMax !== undefined ||
    (f.experience && f.experience !== 'any') ||
    f.platform ||
    f.language ||
    f.hasFreeSlots ||
    f.excludeWarningIds?.length ||
    f.calendar.mode !== 'off',
  );
}

/**
 * Ігри з віковою позначкою, якої глядач не проходить (крім власних ігор майстра), з
 * детальними фільтрами не видаються взагалі: інакше перемиканням фільтрів можна було б
 * вивідати місто, ціну, розклад тощо. Без детальних фільтрів вони лишаються у видачі
 * як `RestrictedGameDto`.
 */
function hideRestricted(viewer: Viewer, now: Date): SQL | undefined {
  const age = viewerAge(viewer, now);
  const failed = RESTRICTED_RATINGS.filter((r) => !meetsAgeRating(age, r));
  if (failed.length === 0) return undefined;
  const notFailed = notInArray(games.ageRating, failed);
  return viewer ? or(notFailed, eq(games.gmUserId, viewer.userId)) : notFailed;
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
  let after: After | null = null;
  if (f.cursor !== undefined) {
    const c = decodeCursor(deps, f.cursor, f.sort);
    after = { r: c.r, k: typeof c.k === 'string' ? new Date(c.k) : c.k, id: c.id };
  }
  const now = new Date();
  const [availability, viewer, busy] = await Promise.all([
    calendarAvailability(deps, f, user),
    resolveViewer(deps, user),
    // Залогінений з увімкненим календарем (`mine`/`custom`): сесії його ігор і імпортовані
    // з iCal події — зайнятий час.
    f.calendar.mode !== 'off' && user
      ? viewerBusy(deps, user.userId, now, new Date(now.getTime() + FIT_HORIZON_DAYS * DAY_MS))
      : Promise.resolve([]),
  ]);
  const filter = memoryFilter(f, availability, busy, now);
  const { order, after: afterCond } = ordering(f.sort);
  const base = sqlFilters(deps, f, now);
  if (hasDetailFilters(f)) {
    const hide = hideRestricted(viewer, now);
    if (hide) base.push(hide);
  }
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
    after = afterOf(last!, f.sort);
  }

  let nextCursor: string | null = null;
  if (picked.length > f.limit) {
    picked.length = f.limit;
    nextCursor = encodeCursor(deps, picked.at(-1)!.l, f.sort);
  } else if (!exhausted && last) {
    nextCursor = encodeCursor(deps, last, f.sort);
  }

  const items = picked.map(({ l, fit }) => {
    const card = toCardView(toCardDto(l, now), l.row.gmUserId, viewer, now);
    if (isRestrictedGame(card) || fit === undefined) return card;
    return { ...card, fit } satisfies SearchGameCardDto;
  });
  return { items, nextCursor };
}
