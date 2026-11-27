import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  CAMPAIGN_PAUSED_REASON,
  dayNumber,
  expandOccurrences,
  fromDayNumber,
  GAME_LOCKED_AFTER_PUBLISH,
  gameInputSchema,
  gamePatchSchema,
  isRestrictedGame,
  meetsAgeRating,
  pauseInputSchema,
  resumeInputSchema,
  scheduleRuleInputSchema,
  toZoned,
  zonedToUtc,
  type GameAction,
  type GameCardDto,
  type MyGameCardDto,
  type GameDto,
  type GameInput,
  type GameStatus,
  type EventType,
  type GameTransitionDto,
  type GameViewDto,
  type GameViewerDto,
  type RestrictedGameDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { SessionUser } from '../auth/session.service.js';
import {
  contentWarnings,
  gameApplications,
  gameBans,
  gameContentWarnings,
  gameMembers,
  games,
  gmBlacklist,
  gameSessions,
  gameSystems,
  genres,
  publishedRatings,
  users,
} from '../db/schema/index.js';
import { publishedOverall, round1 } from '../ratings/ratings.aggregate.js';
import { truncateDescription } from '../seo/excerpt.js';
import {
  applyAgeRatingRaise,
  cancelPendingForGames,
  isRatingRaised,
  logCancelled,
  type CancelledApplication,
  type Tx,
} from '../applications/applications.rules.js';
import { logEvent } from '../events/events.service.js';
import {
  cancelFutureSessions,
  logSessionsCancelled,
  materializeForRow,
  replaceRuleSessions,
  restartRuleAfterPause,
  RULE_CHANGED_REASON,
} from '../sessions/materialize.js';
import { assertNoSanction, isPaid } from '../moderation/sanctions.enforce.js';
import { AppError } from '../http/errors.js';
import { assertImageUrl } from '../http/image-url.js';
import { toCardView, toGameView, viewerAge, type Viewer } from './games.visibility.js';
import { deadGameIdsOf, sessionAnchors, stalenessOf } from './dead-games/rules.js';
import {
  applicationsChanged,
  closeMembersRoom,
  emitGameChanged,
  sessionsChanged,
} from '../realtime/game-rooms.js';
import {
  markGameSessionsViewed,
  markOwnChange,
  markViewed,
  seenFor,
} from '../views/views.service.js';

type GameRow = typeof games.$inferSelect;

export interface Loaded {
  row: GameRow;
  gm: GameDto['gm'];
  systemName: string | null;
  memberCount: number;
  /** Матеріалізовані сесії; `null` — у гри їх немає (тоді найближча — з правила). */
  sessions: SessionStats | null;
  /**
   * Опублікований загальний рейтинг майстра як у БД (2 знаки; ключ сортування `gm_rating`);
   * `null` — немає зрізу.
   */
  gmOverall: number | null;
}

/** Зведення матеріалізованих сесій гри для `nextSessionAt`. */
export interface SessionStats {
  /** Найближча `scheduled` сесія, що починається не раніше моменту завантаження. */
  nextScheduled: Date | null;
  /** Найпізніший матеріалізований слот правила: слоти після нього ще не створено. */
  lastRuleSlot: Date | null;
}

const DAY_MS = 86_400_000;
/** Горизонт пошуку найближчої сесії (з запасом на щомісячні ігри). */
const NEXT_SESSION_HORIZON_MS = 70 * DAY_MS;

// ---------- завантаження й перетворення ----------

/** Ігри з майстром, назвою системи й кількістю учасників (одним пакетним запитом). */
export async function loadGames(
  deps: AppDeps,
  where: SQL | undefined,
  order: SQL[] = [desc(games.createdAt), desc(games.id)],
  limit?: number,
): Promise<Loaded[]> {
  const { db } = deps;
  const query = db
    .select({
      row: games,
      gmPublicId: users.publicId,
      gmNickname: users.nickname,
      gmAvatarUrl: users.avatarUrl,
      gmIsBanned: users.isBanned,
      systemName: gameSystems.name,
      gmOverall: publishedRatings.overall,
      gmUnits: publishedRatings.units,
    })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .leftJoin(gameSystems, eq(gameSystems.id, games.systemId))
    .leftJoin(
      publishedRatings,
      and(eq(publishedRatings.userId, games.gmUserId), eq(publishedRatings.role, 'gm')),
    )
    .where(where)
    .orderBy(...order);
  const rows = await (limit === undefined ? query : query.limit(limit));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ gameId: gameMembers.gameId, n: count() })
    .from(gameMembers)
    .where(
      and(
        inArray(
          gameMembers.gameId,
          rows.map((r) => r.row.id),
        ),
        isNull(gameMembers.leftAt),
      ),
    )
    .groupBy(gameMembers.gameId);
  const byGame = new Map(counts.map((c) => [c.gameId, c.n]));
  const stats = await sessionStats(
    deps,
    rows.map((r) => r.row.id),
    new Date(),
  );
  return rows.map((r) => ({
    row: r.row,
    gm: {
      publicId: r.gmPublicId,
      nickname: r.gmNickname,
      avatarUrl: r.gmAvatarUrl,
      ...(r.gmIsBanned ? { blocked: true as const } : {}),
    },
    systemName: r.systemName,
    memberCount: byGame.get(r.row.id) ?? 0,
    sessions: stats.get(r.row.id) ?? null,
    gmOverall: publishedOverall(r.gmOverall, r.gmUnits),
  }));
}

/** Зведення сесій для набору ігор — одним запитом (без N+1). */
async function sessionStats(
  deps: AppDeps,
  gameIds: number[],
  now: Date,
): Promise<Map<number, SessionStats>> {
  const rows = await deps.db
    .select({
      gameId: gameSessions.gameId,
      nextScheduled: sql<
        string | null
      >`min(case when ${gameSessions.status} = 'scheduled' and ${gameSessions.startsAt} >= ${now} then ${gameSessions.startsAt} end)`,
      lastRuleSlot: sql<string | null>`max(${gameSessions.ruleStartsAt})`,
    })
    .from(gameSessions)
    .where(inArray(gameSessions.gameId, gameIds))
    .groupBy(gameSessions.gameId);
  // Агрегати повертаються рядками 'YYYY-MM-DD HH:MM:SS' (UTC, див. db/client.ts).
  const asDate = (v: string | Date | null): Date | null =>
    v === null ? null : v instanceof Date ? v : new Date(`${v.replace(' ', 'T')}Z`);
  return new Map(
    rows.map((r) => [
      r.gameId,
      { nextScheduled: asDate(r.nextScheduled), lastRuleSlot: asDate(r.lastRuleSlot) },
    ]),
  );
}

async function loadOne(deps: AppDeps, id: number): Promise<Loaded | null> {
  const [g] = await loadGames(deps, eq(games.id, id));
  return g ?? null;
}

async function warningIdsOf(deps: AppDeps, gameId: number): Promise<number[]> {
  const rows = await deps.db
    .select({ id: gameContentWarnings.warningId })
    .from(gameContentWarnings)
    .where(eq(gameContentWarnings.gameId, gameId))
    .orderBy(asc(gameContentWarnings.warningId));
  return rows.map((r) => r.id);
}

/**
 * Найближча сесія, що починається не раніше `now`; для завершених/скасованих/на паузі — `null`.
 * Матеріалізовані сесії мають пріоритет (перенесення й скасування враховано): найближча
 * `scheduled` або перший слот правила після вже матеріалізованих, якщо він раніший. Гра
 * без матеріалізованих сесій (чернетка) — з правила.
 */
function nextSessionAt(l: Pick<Loaded, 'row' | 'sessions'>, now: Date): string | null {
  const { row, sessions } = l;
  if (row.status === 'finished' || row.status === 'cancelled' || row.status === 'paused') {
    return null;
  }
  const scheduled =
    sessions?.nextScheduled && sessions.nextScheduled >= now ? sessions.nextScheduled : null;
  const fromRule = ruleNext(row, sessions?.lastRuleSlot ?? null, now);
  if (scheduled && fromRule) return (scheduled < fromRule ? scheduled : fromRule).toISOString();
  return (scheduled ?? fromRule)?.toISOString() ?? null;
}

/** Перший слот правила ≥ `now` і пізніший за `after` (останній матеріалізований). */
function ruleNext(row: GameRow, after: Date | null, now: Date): Date | null {
  const fromMs = after ? Math.max(now.getTime(), after.getTime() + 1) : now.getTime();
  const from = new Date(fromMs);
  const to = new Date(Math.max(fromMs, row.startsAt.getTime()) + NEXT_SESSION_HORIZON_MS);
  const [first] = expandOccurrences(
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
  return first ? first.start : null;
}

function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toInput(row: GameRow, contentWarningIds: number[]): GameInput {
  return {
    title: row.title,
    description: row.description,
    systemId: row.systemId,
    systemOther: row.systemOther,
    genreId: row.genreId,
    format: row.format,
    city: row.city,
    address: row.address,
    platform: row.platform,
    kind: row.kind,
    startsAt: row.startsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    recurrence: row.recurrence,
    weekdays: row.weekdays,
    minPlayers: row.minPlayers,
    maxPlayers: row.maxPlayers,
    priceUah: row.priceUah,
    ageRating: row.ageRating,
    experience: row.experience,
    language: row.language,
    requirements: row.requirements,
    coverUrl: row.coverUrl,
    channelLinks: row.channelLinks,
    applicationQuestions: row.applicationQuestions,
    customWarnings: row.customWarnings,
    contentWarningIds,
    showWhenFull: row.showWhenFull,
  };
}

function systemRef(l: Loaded): GameDto['system'] {
  return l.row.systemId !== null && l.systemName !== null
    ? { id: l.row.systemId, name: l.systemName }
    : null;
}

const freeSlots = (l: Loaded) => Math.max(0, l.row.maxPlayers - l.memberCount);

function toGameDto(l: Loaded, warningIds: number[], now: Date): GameDto {
  return {
    id: l.row.id,
    ...omit(toInput(l.row, warningIds), 'systemId'),
    system: systemRef(l),
    gm: l.gm,
    timezone: l.row.timezone,
    status: l.row.status,
    nextSessionAt: nextSessionAt(l, now),
    freeSlots: freeSlots(l),
    publishedAt: iso(l.row.publishedAt),
    startedAt: iso(l.row.startedAt),
    finishedAt: iso(l.row.finishedAt),
    cancelledAt: iso(l.row.cancelledAt),
    pausedAt: iso(l.row.pausedAt),
    pauseReason: l.row.pauseReason,
    pauseNote: l.row.pauseNote,
    createdAt: l.row.createdAt.toISOString(),
    updatedAt: l.row.updatedAt.toISOString(),
    gmRating: l.gmOverall === null ? null : round1(l.gmOverall),
    closedByAdmin: l.row.closedByAdmin,
  };
}

export function toCardDto(l: Loaded, now: Date = new Date()): GameCardDto {
  const r = l.row;
  return {
    id: r.id,
    title: r.title,
    // Короткий опис — той самий, що в meta description сторінки гри (≤ 200 символів з «…»).
    summary: truncateDescription(r.description) || null,
    coverUrl: r.coverUrl,
    system: systemRef(l),
    systemOther: r.systemOther,
    genreId: r.genreId,
    gm: l.gm,
    format: r.format,
    city: r.city,
    nextSessionAt: nextSessionAt(l, now),
    timezone: r.timezone,
    freeSlots: freeSlots(l),
    maxPlayers: r.maxPlayers,
    priceUah: r.priceUah,
    ageRating: r.ageRating,
    kind: r.kind,
    language: r.language,
    status: r.status,
    gmRating: l.gmOverall === null ? null : round1(l.gmOverall),
  };
}

async function gmView(deps: AppDeps, id: number): Promise<GameDto> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  return toGameDto(l, await warningIdsOf(deps, id), new Date());
}

// ---------- перевірки ----------

/** Глядач за id користувача; пояс і дата народження — свіжі з БД. */
export async function viewerById(deps: Pick<AppDeps, 'db'>, userId: number): Promise<Viewer> {
  const [u] = await deps.db
    .select({ birthDate: users.birthDate, timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  return u ? { userId, birthDate: u.birthDate, timezone: u.timezone } : null;
}

/** Глядач для правил видимості (`null` — гість). */
export async function resolveViewer(deps: AppDeps, user: SessionUser | undefined): Promise<Viewer> {
  return user ? viewerById(deps, user.userId) : null;
}

async function loadGm(deps: AppDeps, userId: number): Promise<NonNullable<Viewer>> {
  const viewer = await viewerById(deps, userId);
  if (!viewer) throw new AppError(401, 'UNAUTHENTICATED');
  return viewer;
}

function assertGmAge(gm: Viewer, g: GameInput, now: Date): void {
  if (!meetsAgeRating(viewerAge(gm, now), g.ageRating)) {
    throw new AppError(403, 'AGE_RESTRICTED_CREATE');
  }
}

async function assertCatalogRefs(deps: AppDeps, g: GameInput, prev?: GameInput): Promise<void> {
  const { db } = deps;
  const fail = (reason: string) => {
    throw new AppError(400, 'VALIDATION', { reason });
  };
  // Неактивну систему можна лишити в уже створеній грі, але не обрати заново.
  if (g.systemId !== null && g.systemId !== prev?.systemId) {
    const [s] = await db
      .select({ id: gameSystems.id })
      .from(gameSystems)
      .where(and(eq(gameSystems.id, g.systemId), eq(gameSystems.isActive, true)));
    if (!s) fail('UNKNOWN_SYSTEM');
  }
  const [genre] = await db.select({ id: genres.id }).from(genres).where(eq(genres.id, g.genreId));
  if (!genre) fail('UNKNOWN_GENRE');
  if (g.contentWarningIds.length) {
    const found = await db
      .select({ id: contentWarnings.id })
      .from(contentWarnings)
      .where(inArray(contentWarnings.id, g.contentWarningIds));
    if (found.length !== g.contentWarningIds.length) fail('UNKNOWN_WARNING');
  }
}

/** Гра, якою керує користувач: чужа чернетка → 404, інша чужа гра → 403. */
export async function loadOwned(deps: AppDeps, userId: number, id: number): Promise<Loaded> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  if (l.row.gmUserId !== userId) {
    throw l.row.status === 'draft'
      ? new AppError(404, 'NOT_FOUND')
      : new AppError(403, 'FORBIDDEN');
  }
  return l;
}

function columns(g: GameInput) {
  return { ...omit(g, 'contentWarningIds'), startsAt: new Date(g.startsAt) };
}

// ---------- операції ----------

export async function createGame(deps: AppDeps, userId: number, body: unknown): Promise<GameDto> {
  const { db } = deps;
  const gm = await loadGm(deps, userId);
  // «Мертві» ігри майстра блокують створення нових, доки він їх не закриє чи не скаже «все ок».
  const deadGameIds = await deadGameIdsOf(db, userId);
  if (deadGameIds.length) throw new AppError(409, 'GAME_CREATION_BLOCKED', { deadGameIds });
  const input = gameInputSchema(gm.timezone).parse(body);
  const now = new Date();
  assertGmAge(gm, input, now);
  await assertCatalogRefs(deps, input);
  // `no_paid_create`: нову платну гру не створити (безплатну — можна).
  if (isPaid(input.priceUah)) await assertNoSanction(db, userId, 'no_paid_create', now);
  // Мережевий запит — до транзакції (не тримаємо її відкритою під час завантаження).
  if (input.coverUrl !== null) await assertImageUrl(deps, 'coverUrl', input.coverUrl);
  const id = await db.transaction(async (tx) => {
    const [res] = await tx
      .insert(games)
      .values({ ...columns(input), gmUserId: userId, timezone: gm.timezone, status: 'draft' })
      .$returningId();
    const gameId = res!.id;
    if (input.contentWarningIds.length) {
      await tx
        .insert(gameContentWarnings)
        .values(input.contentWarningIds.map((warningId) => ({ gameId, warningId })));
    }
    return gameId;
  });
  await logEvent(db, { type: 'game.created', userId, entityType: 'game', entityId: id });
  await markOwnChange(deps, userId, 'game', [id]);
  return gmView(deps, id);
}

const COPY_SUFFIX = ' (копія)';

/** «<назва> (копія)» не довше 120 символів; ріжемо по кодових точках (без обірваних сурогатів). */
export function copyTitle(title: string): string {
  const chars = Array.from(title);
  while (chars.length && (chars.join('') + COPY_SUFFIX).length > 120) chars.pop();
  return `${chars.join('').trimEnd()}${COPY_SUFFIX}`;
}

/**
 * Початок копії: та сама локальна година й день тижня, що в оригіналу, але першого ж тижня
 * після `now`. Колонка `starts_at` обов'язкова, а правило розкладу має містити день тижня
 * першої сесії, тож порожньої дати в чернетці бути не може; майстер уточнює дату у формі.
 */
export function copyStartsAt(source: Date, tz: string, now: Date): Date {
  const z = toZoned(source, tz);
  let n = dayNumber(z.year, z.month, z.day);
  let at = source;
  while (at <= now) {
    n += 7;
    const d = fromDayNumber(n);
    at = zonedToUtc({ ...d, hour: z.hour, minute: z.minute }, tz);
  }
  return at;
}

/** Копія гри майстра: чернетка з описом і правилом розкладу, без учасників, сесій і паузи. */
export async function cloneGame(deps: AppDeps, userId: number, id: number): Promise<GameDto> {
  const { db } = deps;
  const { row: source } = await loadOwned(deps, userId, id);
  // Закриту адміністрацією гру копією не воскресити; завершену чи скасовану — можна (джерело не змінюється).
  if (source.closedByAdmin) throw new AppError(403, 'FORBIDDEN');
  const gm = await loadGm(deps, userId);
  const deadGameIds = await deadGameIdsOf(db, userId);
  if (deadGameIds.length) throw new AppError(409, 'GAME_CREATION_BLOCKED', { deadGameIds });
  const now = new Date();
  const prev = toInput(source, await warningIdsOf(deps, id));
  // Пояс копії — пояс джерела: дні тижня правила перевірені саме в ньому.
  const tz = source.timezone;
  const input = gameInputSchema(tz).parse({
    ...prev,
    title: copyTitle(source.title),
    startsAt: copyStartsAt(source.startsAt, tz, now).toISOString(),
  });
  assertGmAge(gm, input, now);
  await assertCatalogRefs(deps, input, prev);
  if (isPaid(input.priceUah)) await assertNoSanction(db, userId, 'no_paid_create', now);
  // Обкладинку вже перевірено при збереженні оригіналу: те саме посилання без нового запиту.
  const copyId = await db.transaction(async (tx) => {
    const [res] = await tx
      .insert(games)
      .values({ ...columns(input), gmUserId: userId, timezone: tz, status: 'draft' })
      .$returningId();
    const gameId = res!.id;
    if (input.contentWarningIds.length) {
      await tx
        .insert(gameContentWarnings)
        .values(input.contentWarningIds.map((warningId) => ({ gameId, warningId })));
    }
    return gameId;
  });
  await logEvent(db, {
    type: 'game.created',
    userId,
    entityType: 'game',
    entityId: copyId,
    payload: { clonedFrom: id },
  });
  await markOwnChange(deps, userId, 'game', [copyId]);
  return gmView(deps, copyId);
}

/** Точка для тестів гонки: викликається між читанням гри й записом `PATCH`. */
export const patchHooks: { beforeWrite?: (gameId: number) => Promise<void> } = {};
/** Точка для тестів гонки: між першим читанням гри й транзакцією нового правила розкладу. */
export const ruleHooks: { beforeWrite?: (gameId: number) => Promise<void> } = {};

export async function updateGame(
  deps: AppDeps,
  userId: number,
  id: number,
  body: unknown,
): Promise<GameDto> {
  const { db } = deps;
  const patch = gamePatchSchema.parse(body);
  const { row: seen } = await loadOwned(deps, userId, id);
  if (seen.status === 'finished' || seen.status === 'cancelled') {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  // Нове посилання на обкладинку перевіряється до транзакції; незмінене — ні (уже перевірене).
  if (patch.coverUrl != null && patch.coverUrl !== seen.coverUrl) {
    await assertImageUrl(deps, 'coverUrl', patch.coverUrl);
  }
  await patchHooks.beforeWrite?.(id);
  const gm = await loadGm(deps, userId);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Патч зливається зі свіжим рядком під X-блокуванням: паралельний PATCH чи нове правило
    // (`PUT /schedule`) не загубляться. Якщо статус змінився після першого читання
    // (опублікували/скасували) — 409, заблоковані поля не змінюються.
    const [row] = await tx.select().from(games).where(eq(games.id, id)).for('update');
    if (!row || row.status !== seen.status) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    const warningIds = (
      await tx
        .select({ id: gameContentWarnings.warningId })
        .from(gameContentWarnings)
        .where(eq(gameContentWarnings.gameId, id))
        .orderBy(asc(gameContentWarnings.warningId))
    ).map((w) => w.id);
    const current = toInput(row, warningIds);
    if (row.status !== 'draft') {
      for (const field of GAME_LOCKED_AFTER_PUBLISH) {
        if (patch[field] !== undefined && patch[field] !== current[field]) {
          throw new AppError(409, 'GAME_FIELD_LOCKED', { field });
        }
      }
    }
    const next = gameInputSchema(row.timezone).parse({ ...current, ...patch });
    assertGmAge(gm, next, now);
    // `no_paid_create`: безплатну гру не зробити платною (наявна платна лишається як є).
    if (isPaid(next.priceUah) && !isPaid(row.priceUah)) {
      await assertNoSanction(tx, userId, 'no_paid_create', now);
    }
    await assertCatalogRefs(deps, next, current);
    // Зміна розкладу опублікованої гри — те саме, що нове правило (`PUT /schedule`): перша
    // сесія має бути в майбутньому, майбутні сесії правила замінюються.
    const ruleChanged = row.status !== 'draft' && isRuleChanged(current, next);
    // Розклад кампейну на паузі змінюється лише відновленням (`resume` з новою датою).
    if (ruleChanged && row.status === 'paused') throw new AppError(409, 'GAME_PAUSED');
    const startsMoved = row.status === 'recruiting' && next.startsAt !== current.startsAt;
    if ((ruleChanged || startsMoved) && new Date(next.startsAt) <= now) {
      throw new AppError(422, 'GAME_IN_PAST');
    }
    await tx.update(games).set(columns(next)).where(eq(games.id, id));
    // Під X-блокуванням гри (затвердження бере FOR SHARE) кількість учасників не зміниться.
    if (next.maxPlayers < current.maxPlayers && next.maxPlayers < (await activeCount(tx, id))) {
      throw new AppError(409, 'MAX_BELOW_MEMBERS');
    }
    if (patch.contentWarningIds !== undefined) {
      await tx.delete(gameContentWarnings).where(eq(gameContentWarnings.gameId, id));
      if (next.contentWarningIds.length) {
        await tx
          .insert(gameContentWarnings)
          .values(next.contentWarningIds.map((warningId) => ({ gameId: id, warningId })));
      }
    }
    const ruleCancelled = ruleChanged
      ? await replaceRuleSessions(tx, { ...row, ...columns(next) }, now)
      : [];
    // Рядок гри заблоковано (X), тож паралельні заявки/затвердження чекають.
    const cancelled =
      row.status !== 'draft' && isRatingRaised(current.ageRating, next.ageRating)
        ? await applyAgeRatingRaise(tx, id, next.ageRating, now)
        : [];
    return { cancelled, current, next, ruleChanged, ruleCancelled };
  });
  const { cancelled, current, next, ruleChanged, ruleCancelled } = result;
  await logCancelled(db, cancelled, 'application.cancelled_age');
  await logEvent(db, {
    type: 'game.updated',
    userId,
    entityType: 'game',
    entityId: id,
    payload: {
      fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
    },
  });
  if (ruleChanged) await logRuleChanged(deps, userId, id, current, next);
  await logSessionsCancelled(db, userId, ruleCancelled, RULE_CHANGED_REASON);
  await markOwnChange(deps, userId, 'game', [id]);
  emitGameChanged(deps, id, 'details', 'watchers');
  if (ruleChanged) {
    await markGameSessionsViewed(deps, userId, id);
    emitGameChanged(deps, id, 'sessions', 'members');
  }
  pingCancelledApplications(deps, id, userId, cancelled);
  return gmView(deps, id);
}

// ---------- правило розкладу ----------

const RULE_FIELDS = ['startsAt', 'durationMinutes', 'recurrence', 'weekdays'] as const;
type Rule = Pick<GameInput, (typeof RULE_FIELDS)[number]>;

const pickRule = (g: Rule): Rule => ({
  startsAt: g.startsAt,
  durationMinutes: g.durationMinutes,
  recurrence: g.recurrence,
  weekdays: g.weekdays,
});

function isRuleChanged(a: Rule, b: Rule): boolean {
  return RULE_FIELDS.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
}

async function logRuleChanged(
  deps: AppDeps,
  userId: number,
  gameId: number,
  from: Rule,
  to: Rule,
  type: 'game.rule_changed' | 'game.converted_to_campaign' = 'game.rule_changed',
): Promise<void> {
  await logEvent(deps.db, {
    type,
    userId,
    entityType: 'game',
    entityId: gameId,
    payload: { from: pickRule(from), to: pickRule(to) },
  });
}

/**
 * Нове правило розкладу для майбутніх сесій (`PUT /api/games/:id/schedule`, лише кампанія)
 * або «перетворити на кампанію» (`POST /api/games/:id/convert-to-campaign`, лише ваншот;
 * єдиний шлях змінити заблоковане `kind`). Гра — `recruiting|started`; перша сесія нового
 * правила — у майбутньому. Майбутні неперенесені сесії правила замінюються новими;
 * перенесені, скасовані й завершені лишаються.
 */
export async function changeScheduleRule(
  deps: AppDeps,
  userId: number,
  id: number,
  body: unknown,
  mode: 'schedule' | 'convert',
): Promise<GameDto> {
  const { db } = deps;
  const input = scheduleRuleInputSchema.parse(body);
  // Перше читання — лише доступ (404/403) і швидкі відмови; рішення — на свіжому рядку нижче.
  const { row: seen } = await loadOwned(deps, userId, id);
  const check = (row: GameRow) => {
    if (row.status !== 'recruiting' && row.status !== 'started') {
      throw new AppError(409, 'GAME_INVALID_TRANSITION');
    }
    if (row.kind !== (mode === 'convert' ? 'oneshot' : 'campaign')) {
      throw new AppError(409, 'GAME_INVALID_TRANSITION');
    }
  };
  check(seen);
  if (mode === 'convert' && input.recurrence === 'none') {
    throw new AppError(400, 'VALIDATION', { reason: 'RECURRENCE_REQUIRED' });
  }
  await ruleHooks.beforeWrite?.(id);
  const now = new Date();
  const { current, next, ruleCancelled } = await db.transaction(async (tx) => {
    // Свіжий рядок під X-блокуванням: паралельний PATCH (тривалість, поля) чи перехід
    // статусу не загубляться й не будуть перезаписані значеннями з першого читання.
    const [row] = await tx.select().from(games).where(eq(games.id, id)).for('update');
    if (!row) throw new AppError(404, 'NOT_FOUND');
    check(row);
    const warningIds = (
      await tx
        .select({ id: gameContentWarnings.warningId })
        .from(gameContentWarnings)
        .where(eq(gameContentWarnings.gameId, id))
        .orderBy(asc(gameContentWarnings.warningId))
    ).map((w) => w.id);
    const current = toInput(row, warningIds);
    const next = gameInputSchema(row.timezone).parse({
      ...current,
      kind: 'campaign',
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes ?? current.durationMinutes,
      recurrence: input.recurrence,
      weekdays: input.weekdays,
    });
    if (new Date(next.startsAt) <= now) throw new AppError(422, 'GAME_IN_PAST');
    const set = { kind: next.kind, ...pickRule(next), startsAt: new Date(next.startsAt) };
    await tx.update(games).set(set).where(eq(games.id, id));
    const ruleCancelled = await replaceRuleSessions(tx, { ...row, ...set }, now);
    return { current, next, ruleCancelled };
  });
  await logRuleChanged(
    deps,
    userId,
    id,
    current,
    next,
    mode === 'convert' ? 'game.converted_to_campaign' : 'game.rule_changed',
  );
  await logSessionsCancelled(db, userId, ruleCancelled, RULE_CHANGED_REASON);
  await markOwnChange(deps, userId, 'game', [id]);
  await markGameSessionsViewed(deps, userId, id);
  sessionsChanged(deps, id);
  return gmView(deps, id);
}

/** Скасовані разом зі зміною гри `pending`-заявки: пінг майстру й авторам. */
function pingCancelledApplications(
  deps: AppDeps,
  gameId: number,
  gmUserId: number,
  cancelled: CancelledApplication[],
): void {
  if (cancelled.length === 0) return;
  applicationsChanged(deps, gameId, [gmUserId, ...cancelled.map((c) => c.userId)]);
}

/** Прості переходи (без тіла); `pause`/`resume` — окремі `pauseGame`/`resumeGame`. */
type PlainAction = Exclude<GameAction, 'pause' | 'resume'>;

const TRANSITIONS: Record<
  PlainAction,
  {
    from: GameStatus[];
    to: GameStatus;
    stamp: 'publishedAt' | 'startedAt' | 'finishedAt' | 'cancelledAt';
  }
> = {
  publish: { from: ['draft'], to: 'recruiting', stamp: 'publishedAt' },
  start: { from: ['recruiting'], to: 'started', stamp: 'startedAt' },
  finish: { from: ['started', 'paused'], to: 'finished', stamp: 'finishedAt' },
  cancel: {
    from: ['draft', 'recruiting', 'started', 'paused'],
    to: 'cancelled',
    stamp: 'cancelledAt',
  },
};

const EVENT: Record<PlainAction, EventType> = {
  publish: 'game.published',
  start: 'game.started',
  finish: 'game.finished',
  cancel: 'game.cancelled',
};

/** Активні учасники гри (`left_at IS NULL`). */
async function activeCount(tx: Tx, gameId: number): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)));
  return r?.n ?? 0;
}

/**
 * «Завершити гру» для ваншота завершує й його єдину сесію (`scheduled` → `done`). Сесію,
 * якої ще немає (гру опубліковано до матеріалізації), спершу створюємо з правила.
 */
async function finishOneshotSession(tx: Tx, row: GameRow, now: Date): Promise<number[]> {
  await materializeForRow(tx, row, now, row.startsAt);
  const open = await tx
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(and(eq(gameSessions.gameId, row.id), eq(gameSessions.status, 'scheduled')))
    .for('update');
  if (open.length === 0) return [];
  const ids = open.map((s) => s.id);
  await tx
    .update(gameSessions)
    .set({ status: 'done', doneAt: now })
    .where(and(inArray(gameSessions.id, ids), eq(gameSessions.status, 'scheduled')));
  return ids;
}

/**
 * Перехід статусу. Старт з меншою за мінімум кількістю учасників дозволено — у відповіді
 * `warning: 'BELOW_MIN_PLAYERS'`. Скасування й завершення скасовують `pending`-заявки
 * (`game_cancelled` / `game_finished`).
 */
export async function transitionGame(
  deps: AppDeps,
  userId: number,
  id: number,
  action: GameAction,
  body?: unknown,
): Promise<GameTransitionDto> {
  // Лише майстер гри (адміністрація й модератори — теж 403, якщо це не їхня гра).
  const { row } = await loadOwned(deps, userId, id);
  if (action === 'pause') return pauseGame(deps, userId, row, body);
  if (action === 'resume') return resumeGame(deps, userId, row, body);
  return applyTransition(deps, userId, row, action);
}

// ---------- пауза кампейну ----------

/**
 * «Поставити на паузу» (`POST /api/games/:id/pause`, тіло `{ reason, note? }`): лише кампанія
 * в `recruiting|started`. Майбутні `scheduled` сесії → `cancelled` (`campaign_paused`);
 * минулі, уже скасовані й завершені сесії, склад учасників — без змін. `pending`-заявки
 * лишаються `pending` (майстер вирішить після відновлення); нові заявки й затвердження —
 * 409 `GAME_PAUSED`. Позначки «мертва»/«підозріла» знімаються (детектор паузу не перевіряє).
 */
async function pauseGame(
  deps: AppDeps,
  userId: number,
  row: GameRow,
  body: unknown,
): Promise<GameTransitionDto> {
  const { db } = deps;
  const id = row.id;
  const input = pauseInputSchema.parse(body ?? {});
  if (row.status !== 'recruiting' && row.status !== 'started') {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  if (row.kind !== 'campaign') throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const now = new Date();
  const cancelledSessions = await db.transaction(async (tx) => {
    // Умова за поточним статусом захищає від гонки двох переходів (повторна пауза → 409).
    const [res] = await tx
      .update(games)
      .set({
        status: 'paused',
        pausedAt: now,
        pauseReason: input.reason,
        pauseNote: input.note,
        deadAt: null,
        suspiciousAt: null,
      })
      .where(and(eq(games.id, id), eq(games.status, row.status), eq(games.kind, 'campaign')));
    if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    return cancelFutureSessions(tx, [id], now, CAMPAIGN_PAUSED_REASON);
  });
  await logEvent(db, {
    type: 'game.paused',
    userId,
    entityType: 'game',
    entityId: id,
    payload: { from: row.status, to: 'paused', reason: input.reason, note: input.note },
  });
  await logSessionsCancelled(db, userId, cancelledSessions, CAMPAIGN_PAUSED_REASON);
  await markOwnChange(deps, userId, 'game', [id]);
  await markGameSessionsViewed(deps, userId, id);
  sessionsChanged(deps, id);
  return gmView(deps, id);
}

/**
 * «Відновити» / «Оголосити донабір» (`POST /api/games/:id/resume`, тіло
 * `{ startsAt, recruit }`): `paused` → `started`, `showWhenFull = recruit`. Правило розкладу
 * (дні тижня, частота, тривалість) лишається, перезапускається від `startsAt`: ціла хвилина,
 * у майбутньому (інакше 422 `GAME_IN_PAST`, як у публікації й зміні розкладу), день тижня — з
 * `weekdays` у поясі гри (інакше 400 `VALIDATION` з issue по `weekdays`). Пауза, що почалась
 * у `recruiting` (`startedAt` ще немає), — це й старт гри: як і `start`, з меншою за мінімум
 * кількістю учасників у відповіді `warning: 'BELOW_MIN_PLAYERS'`.
 */
async function resumeGame(
  deps: AppDeps,
  userId: number,
  seen: GameRow,
  body: unknown,
): Promise<GameTransitionDto> {
  const { db } = deps;
  const id = seen.id;
  const input = resumeInputSchema.parse(body ?? {});
  if (seen.status !== 'paused') throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const now = new Date();
  if (new Date(input.startsAt) <= now) {
    throw new AppError(422, 'GAME_IN_PAST');
  }
  const { startsAt, belowMin } = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(games).where(eq(games.id, id)).for('update');
    if (!row || row.status !== 'paused') throw new AppError(409, 'GAME_INVALID_TRANSITION');
    // Перевіряємо лише те, що змінює відновлення: день `startsAt` має входити в `weekdays`
    // щотижневого правила (у поясі гри). Решту гри не валідуємо — застарілі поля (напр.
    // http-посилання з давніх даних) не мають блокувати відновлення.
    assertRuleWeekday(row, input.startsAt);
    const set = {
      status: 'started' as const,
      startsAt: new Date(input.startsAt),
      showWhenFull: input.recruit,
      startedAt: row.startedAt ?? now,
      pausedAt: null,
      pauseReason: null,
      pauseNote: null,
      // Від відновлення рахується давність гри: довга пауза не робить її «мертвою» одразу.
      resumedAt: now,
    };
    await tx.update(games).set(set).where(eq(games.id, id));
    await restartRuleAfterPause(tx, { ...row, ...set }, now);
    // Пауза з набору: відновлення — перший старт гри (попередження, як у `start`).
    const belowMin = row.startedAt === null && (await activeCount(tx, id)) < row.minPlayers;
    return { startsAt: input.startsAt, belowMin };
  });
  await logEvent(db, {
    type: 'game.resumed',
    userId,
    entityType: 'game',
    entityId: id,
    payload: { from: 'paused', to: 'started', startsAt, recruit: input.recruit },
  });
  await markOwnChange(deps, userId, 'game', [id]);
  await markGameSessionsViewed(deps, userId, id);
  sessionsChanged(deps, id);
  const view = await gmView(deps, id);
  return belowMin ? { ...view, warning: 'BELOW_MIN_PLAYERS' } : view;
}

/**
 * День першої сесії після паузи — один із днів щотижневого правила в поясі гри; інакше
 * 400 `VALIDATION` з issue по `weekdays` (як у `gameInputSchema`).
 */
function assertRuleWeekday(
  row: Pick<GameRow, 'recurrence' | 'weekdays' | 'timezone'>,
  startsAt: string,
): void {
  if (row.recurrence !== 'weekly' && row.recurrence !== 'biweekly') return;
  const wd = toZoned(new Date(startsAt), row.timezone).weekday;
  if (row.weekdays.includes(wd)) return;
  throw new ZodError([
    {
      code: 'custom',
      path: ['weekdays'],
      message: 'Weekdays must include the weekday of startsAt',
      input: startsAt,
    },
  ]);
}

/** Закриття адміністрацією (вкладка «Мертві ігри»): хто й що ще записати в транзакції переходу. */
export interface AdminClose {
  /** Записи журналу модерації й сповіщення майстру — у транзакції самого переходу. */
  inTx: (tx: Tx, now: Date) => Promise<void>;
}

/**
 * Перехід статусу гри від імені майстра (`actorId`) або адміністрації (`admin`: подія — без
 * автора й з `closedByAdmin`, гра — з позначкою `closed_by_admin`). Завершення й скасування
 * знімають позначки «мертва»/«підозріла».
 */
export async function applyTransition(
  deps: AppDeps,
  actorId: number,
  row: GameRow,
  action: PlainAction,
  admin?: AdminClose,
): Promise<GameTransitionDto> {
  const { db } = deps;
  const id = row.id;
  const userId = actorId;
  const t = TRANSITIONS[action];
  if (!t.from.includes(row.status)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const now = new Date();
  if (action === 'publish' && row.startsAt <= now) throw new AppError(422, 'GAME_IN_PAST');
  const endReason =
    action === 'cancel' ? 'game_cancelled' : action === 'finish' ? 'game_finished' : null;
  const ends = endReason
    ? { deadAt: null, suspiciousAt: null, ...(admin ? { closedByAdmin: true } : {}) }
    : {};
  const { cancelled, belowMin, doneSessionIds, cancelledSessions } = await db.transaction(
    async (tx) => {
      // Умова за поточним статусом захищає від гонки двох переходів.
      const [res] = await tx
        .update(games)
        .set({ status: t.to, [t.stamp]: now, ...ends })
        .where(and(eq(games.id, id), eq(games.status, row.status)));
      if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
      // Публікація й старт зсувають вікно сесій (рядок гри вже під X-блокуванням).
      if (action === 'publish' || action === 'start') {
        await materializeForRow(tx, { ...row, status: t.to }, now);
      }
      const doneSessionIds =
        action === 'finish' && row.kind === 'oneshot'
          ? await finishOneshotSession(tx, row, now)
          : [];
      const belowMin = action === 'start' && (await activeCount(tx, id)) < row.minPlayers;
      const cancelled: CancelledApplication[] = endReason
        ? await cancelPendingForGames(tx, [id], now, endReason)
        : [];
      // Майбутні сесії завершеної/скасованої гри скасовуються; минулі `scheduled` лишаються.
      const cancelledSessions = endReason
        ? await cancelFutureSessions(tx, [id], now, endReason)
        : [];
      if (admin) await admin.inTx(tx, now);
      return { cancelled, belowMin, doneSessionIds, cancelledSessions };
    },
  );
  // Закриття адміністрацією: подія без автора (учасники не бачать, хто з персоналу закрив),
  // майстер отримує окреме `game.closed_by_admin` замість `game.*` з події.
  const eventUserId = admin ? null : userId;
  await logEvent(db, {
    type: EVENT[action],
    userId: eventUserId,
    entityType: 'game',
    entityId: id,
    payload: { from: row.status, to: t.to, ...(admin ? { closedByAdmin: true } : {}) },
  });
  await logCancelled(db, cancelled, 'application.cancelled_game');
  for (const sessionId of doneSessionIds) {
    await logEvent(db, {
      type: 'session.done',
      userId: eventUserId,
      entityType: 'session',
      entityId: sessionId,
      payload: { gameId: id, present: [], absent: [], reason: 'game_finished' },
    });
  }
  if (endReason) await logSessionsCancelled(db, eventUserId, cancelledSessions, endReason);
  if (!admin) {
    await markOwnChange(deps, userId, 'game', [id]);
    await markGameSessionsViewed(deps, userId, id);
  }
  // Публікація: учасників ще немає — лише `details` (інші вкладки майстра).
  if (action === 'publish') emitGameChanged(deps, id, 'details', 'watchers');
  else sessionsChanged(deps, id);
  pingCancelledApplications(deps, id, row.gmUserId, cancelled);
  if (action === 'cancel') closeMembersRoom(deps, id);
  const view = await gmView(deps, id);
  return belowMin ? { ...view, warning: 'BELOW_MIN_PLAYERS' } : view;
}

export async function getGameView(deps: AppDeps, viewer: Viewer, id: number): Promise<GameViewDto> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  const now = new Date();
  const dto = toGameDto(l, await warningIdsOf(deps, id), now);
  const base = toGameView(dto, l.row.gmUserId, viewer, false, now);
  if (!base) throw new AppError(404, 'NOT_FOUND');
  // Стосунок (4 запити) — лише для автентифікованого глядача з повним видом.
  if (!viewer || isRestrictedGame(base)) return base;
  const [rel, seen] = await Promise.all([
    viewerRelation(deps, l.row, viewer.userId),
    seenFor(deps, viewer.userId, 'game', [l.row]),
  ]);
  const view =
    rel.relation === 'member' ? (toGameView(dto, l.row.gmUserId, viewer, true, now) ?? base) : base;
  // Відкриття деталей — перегляд саме завантаженої версії (зміна після завантаження
  // лишиться «оновленням»); `seen` у відповіді — стан ДО цього запиту.
  try {
    await markViewed(deps, viewer.userId, 'game', [id], l.row.updatedAt);
  } catch (err) {
    // Перегляд — побічний ефект: його збій не ламає показ гри.
    console.error('[views] mark game viewed failed', err);
  }
  return { ...view, viewer: rel, seen: seen.get(id) ?? 'new' };
}

/** Стосунок автентифікованого глядача до гри (див. `GameViewerDto`). */
async function viewerRelation(deps: AppDeps, g: GameRow, userId: number): Promise<GameViewerDto> {
  const none = (relation: GameViewerDto['relation']) => ({ relation, applicationId: null });
  if (g.gmUserId === userId) return none('gm');
  const { db } = deps;
  const [memberships, [app], [ban], [black]] = await Promise.all([
    db
      .select({ id: gameMembers.id, leftAt: gameMembers.leftAt })
      .from(gameMembers)
      .where(and(eq(gameMembers.gameId, g.id), eq(gameMembers.userId, userId))),
    db
      .select({ id: gameApplications.id })
      .from(gameApplications)
      .where(
        and(
          eq(gameApplications.gameId, g.id),
          eq(gameApplications.userId, userId),
          eq(gameApplications.status, 'pending'),
        ),
      ),
    db
      .select({ id: gameBans.userId })
      .from(gameBans)
      .where(and(eq(gameBans.gameId, g.id), eq(gameBans.userId, userId))),
    db
      .select({ id: gmBlacklist.userId })
      .from(gmBlacklist)
      .where(and(eq(gmBlacklist.gmUserId, g.gmUserId), eq(gmBlacklist.userId, userId))),
  ]);
  if (memberships.some((r) => r.leftAt === null)) return none('member');
  // Колишній учасник (вийшов, виключений, забанений) — може мати «вихідні» оцінки.
  const former = memberships.length > 0 ? { wasMember: true as const } : {};
  if (app) return { relation: 'pending', applicationId: app.id, ...former };
  if (ban) return { ...none('banned'), ...former };
  if (black) return { ...none('blacklisted'), ...former };
  return { ...none('none'), ...former };
}

/** «Мої ігри»: усі ігри майстра в усіх статусах. */
export async function listMyGames(deps: AppDeps, userId: number): Promise<MyGameCardDto[]> {
  const now = new Date();
  const loaded = await loadGames(deps, eq(games.gmUserId, userId));
  if (loaded.length === 0) return [];
  const pending = await deps.db
    .select({ gameId: gameApplications.gameId, n: count() })
    .from(gameApplications)
    .where(
      and(
        inArray(
          gameApplications.gameId,
          loaded.map((l) => l.row.id),
        ),
        eq(gameApplications.status, 'pending'),
      ),
    )
    .groupBy(gameApplications.gameId);
  const byGame = new Map(pending.map((p) => [p.gameId, p.n]));
  const anchors = await sessionAnchors(
    deps.db,
    loaded.map((l) => l.row.id),
  );
  const seen = await seenFor(
    deps,
    userId,
    'game',
    loaded.map((l) => l.row),
  );
  return loaded.map((l) => ({
    ...toCardDto(l, now),
    minPlayers: l.row.minPlayers,
    memberCount: l.memberCount,
    pendingApplications: byGame.get(l.row.id) ?? 0,
    seen: seen.get(l.row.id) ?? 'new',
    staleness: stalenessOf(l.row, anchors.get(l.row.id), now),
    suspicious: l.row.suspiciousAt !== null,
  }));
}

/**
 * Статуси, що показуються в історії ігор профілю. Скасовані — теж, але лише опубліковані
 * (умова `publishedAt` нижче): скасована чернетка лишається приватною (R9).
 */
const PROFILE_STATUSES: GameStatus[] = ['recruiting', 'started', 'paused', 'finished', 'cancelled'];

/** Ігри користувача для публічного профілю (опубліковані; без чернеток). */
export async function listProfileGames(
  deps: AppDeps,
  userId: number,
  viewer: Viewer,
): Promise<{
  asGm: (GameCardDto | RestrictedGameDto)[];
  asPlayer: (GameCardDto | RestrictedGameDto)[];
}> {
  const now = new Date();
  const order = [desc(games.startsAt), desc(games.id)];
  // Лише опубліковані: неопублікована гра (зокрема скасована чернетка) не показується.
  const visible = and(inArray(games.status, PROFILE_STATUSES), isNotNull(games.publishedAt));
  // Будь-яке членство — активне чи завершене виходом/виключенням/баном (історія гравця).
  const memberOf = deps.db
    .select({ id: gameMembers.gameId })
    .from(gameMembers)
    .where(eq(gameMembers.userId, userId));
  const [asGm, asPlayer] = await Promise.all([
    loadGames(deps, and(visible, eq(games.gmUserId, userId)), order),
    loadGames(deps, and(visible, inArray(games.id, memberOf)), order),
  ]);
  const view = (l: Loaded) => toCardView(toCardDto(l, now), l.row.gmUserId, viewer, now);
  return { asGm: asGm.map(view), asPlayer: asPlayer.map(view) };
}
