import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  expandOccurrences,
  GAME_LOCKED_AFTER_PUBLISH,
  gameInputSchema,
  gamePatchSchema,
  meetsAgeRating,
  scheduleRuleInputSchema,
  type GameAction,
  type GameCardDto,
  type GameDto,
  type GameInput,
  type GameStatus,
  type EventType,
  type GameTransitionDto,
  type GameViewDto,
  type RestrictedGameDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { SessionUser } from '../auth/session.service.js';
import {
  contentWarnings,
  gameContentWarnings,
  gameMembers,
  games,
  gameSessions,
  gameSystems,
  genres,
  users,
} from '../db/schema/index.js';
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
} from '../sessions/materialize.js';
import { AppError } from '../http/errors.js';
import { toCardView, toGameView, viewerAge, type Viewer } from './games.visibility.js';

type GameRow = typeof games.$inferSelect;

export interface Loaded {
  row: GameRow;
  gm: GameDto['gm'];
  systemName: string | null;
  memberCount: number;
  /** Матеріалізовані сесії; `null` — у гри їх немає (тоді найближча — з правила). */
  sessions: SessionStats | null;
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
      systemName: gameSystems.name,
    })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .leftJoin(gameSystems, eq(gameSystems.id, games.systemId))
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
    gm: { publicId: r.gmPublicId, nickname: r.gmNickname, avatarUrl: r.gmAvatarUrl },
    systemName: r.systemName,
    memberCount: byGame.get(r.row.id) ?? 0,
    sessions: stats.get(r.row.id) ?? null,
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
 * Найближча сесія, що починається не раніше `now`; для завершених/скасованих — `null`.
 * Матеріалізовані сесії мають пріоритет (перенесення й скасування враховано): найближча
 * `scheduled` або перший слот правила після вже матеріалізованих, якщо він раніший. Гра
 * без матеріалізованих сесій (чернетка) — з правила.
 */
function nextSessionAt(l: Pick<Loaded, 'row' | 'sessions'>, now: Date): string | null {
  const { row, sessions } = l;
  if (row.status === 'finished' || row.status === 'cancelled') return null;
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
    createdAt: l.row.createdAt.toISOString(),
    updatedAt: l.row.updatedAt.toISOString(),
  };
}

export function toCardDto(l: Loaded, now: Date = new Date()): GameCardDto {
  const r = l.row;
  return {
    id: r.id,
    title: r.title,
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
  };
}

async function gmView(deps: AppDeps, id: number): Promise<GameDto> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  return toGameDto(l, await warningIdsOf(deps, id), new Date());
}

// ---------- перевірки ----------

/** Глядач за id користувача; пояс і дата народження — свіжі з БД. */
export async function viewerById(deps: AppDeps, userId: number): Promise<Viewer> {
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
async function loadOwned(deps: AppDeps, userId: number, id: number): Promise<Loaded> {
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
  const input = gameInputSchema(gm.timezone).parse(body);
  const now = new Date();
  assertGmAge(gm, input, now);
  await assertCatalogRefs(deps, input);
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
  return gmView(deps, id);
}

/** Точка для тестів гонки: викликається між читанням гри й записом `PATCH`. */
export const patchHooks: { beforeWrite?: (gameId: number) => Promise<void> } = {};

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
  await patchHooks.beforeWrite?.(id);
  const gm = await loadGm(deps, userId);
  const now = new Date();
  const { cancelled, current, next, ruleChanged } = await db.transaction(async (tx) => {
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
    await assertCatalogRefs(deps, next, current);
    // Зміна розкладу опублікованої гри — те саме, що нове правило (`PUT /schedule`): перша
    // сесія має бути в майбутньому, майбутні сесії правила замінюються.
    const ruleChanged = row.status !== 'draft' && isRuleChanged(current, next);
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
    if (ruleChanged) await replaceRuleSessions(tx, { ...row, ...columns(next) }, now);
    // Рядок гри заблоковано (X), тож паралельні заявки/затвердження чекають.
    const cancelled =
      row.status !== 'draft' && isRatingRaised(current.ageRating, next.ageRating)
        ? await applyAgeRatingRaise(tx, id, next.ageRating, now)
        : [];
    return { cancelled, current, next, ruleChanged };
  });
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
  const { row } = await loadOwned(deps, userId, id);
  if (row.status !== 'recruiting' && row.status !== 'started') {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  if (row.kind !== (mode === 'convert' ? 'oneshot' : 'campaign')) {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  if (mode === 'convert' && input.recurrence === 'none') {
    throw new AppError(400, 'VALIDATION', { reason: 'RECURRENCE_REQUIRED' });
  }
  const current = toInput(row, await warningIdsOf(deps, id));
  const next = gameInputSchema(row.timezone).parse({
    ...current,
    kind: 'campaign',
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes ?? current.durationMinutes,
    recurrence: input.recurrence,
    weekdays: input.weekdays,
  });
  const now = new Date();
  if (new Date(next.startsAt) <= now) throw new AppError(422, 'GAME_IN_PAST');
  const set = { kind: next.kind, ...pickRule(next), startsAt: new Date(next.startsAt) };
  await db.transaction(async (tx) => {
    // Умова за прочитаними статусом і видом: паралельний перехід чи перетворення → 409.
    const [res] = await tx
      .update(games)
      .set(set)
      .where(and(eq(games.id, id), eq(games.status, row.status), eq(games.kind, row.kind)));
    if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    await replaceRuleSessions(tx, { ...row, ...set }, now);
  });
  await logRuleChanged(
    deps,
    userId,
    id,
    current,
    next,
    mode === 'convert' ? 'game.converted_to_campaign' : 'game.rule_changed',
  );
  return gmView(deps, id);
}

const TRANSITIONS: Record<
  GameAction,
  {
    from: GameStatus[];
    to: GameStatus;
    stamp: 'publishedAt' | 'startedAt' | 'finishedAt' | 'cancelledAt';
  }
> = {
  publish: { from: ['draft'], to: 'recruiting', stamp: 'publishedAt' },
  start: { from: ['recruiting'], to: 'started', stamp: 'startedAt' },
  finish: { from: ['started'], to: 'finished', stamp: 'finishedAt' },
  cancel: { from: ['draft', 'recruiting', 'started'], to: 'cancelled', stamp: 'cancelledAt' },
};

const EVENT: Record<GameAction, EventType> = {
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
): Promise<GameTransitionDto> {
  const { db } = deps;
  const t = TRANSITIONS[action];
  const { row } = await loadOwned(deps, userId, id);
  if (!t.from.includes(row.status)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const now = new Date();
  if (action === 'publish' && row.startsAt <= now) throw new AppError(422, 'GAME_IN_PAST');
  const endReason =
    action === 'cancel' ? 'game_cancelled' : action === 'finish' ? 'game_finished' : null;
  const { cancelled, belowMin, doneSessionIds, cancelledSessions } = await db.transaction(
    async (tx) => {
      // Умова за поточним статусом захищає від гонки двох переходів.
      const [res] = await tx
        .update(games)
        .set({ status: t.to, [t.stamp]: now })
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
      return { cancelled, belowMin, doneSessionIds, cancelledSessions };
    },
  );
  await logEvent(db, {
    type: EVENT[action],
    userId,
    entityType: 'game',
    entityId: id,
    payload: { from: row.status, to: t.to },
  });
  await logCancelled(db, cancelled, 'application.cancelled_game');
  for (const sessionId of doneSessionIds) {
    await logEvent(db, {
      type: 'session.done',
      userId,
      entityType: 'session',
      entityId: sessionId,
      payload: { gameId: id, present: [], absent: [], reason: 'game_finished' },
    });
  }
  if (endReason) await logSessionsCancelled(db, userId, cancelledSessions, endReason);
  const view = await gmView(deps, id);
  return belowMin ? { ...view, warning: 'BELOW_MIN_PLAYERS' } : view;
}

export async function getGameView(deps: AppDeps, viewer: Viewer, id: number): Promise<GameViewDto> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  let isMember = false;
  if (viewer) {
    const [m] = await deps.db
      .select({ id: gameMembers.gameId })
      .from(gameMembers)
      .where(
        and(
          eq(gameMembers.gameId, id),
          eq(gameMembers.userId, viewer.userId),
          isNull(gameMembers.leftAt),
        ),
      );
    isMember = Boolean(m);
  }
  const now = new Date();
  const view = toGameView(
    toGameDto(l, await warningIdsOf(deps, id), now),
    l.row.gmUserId,
    viewer,
    isMember,
    now,
  );
  if (!view) throw new AppError(404, 'NOT_FOUND');
  return view;
}

/** «Мої ігри»: усі ігри майстра в усіх статусах. */
export async function listMyGames(deps: AppDeps, userId: number): Promise<GameCardDto[]> {
  const now = new Date();
  return (await loadGames(deps, eq(games.gmUserId, userId))).map((l) => toCardDto(l, now));
}

/**
 * Статуси, що показуються в історії ігор профілю. Скасовані — теж, але лише опубліковані
 * (умова `publishedAt` нижче): скасована чернетка лишається приватною (R9).
 */
const PROFILE_STATUSES: GameStatus[] = ['recruiting', 'started', 'finished', 'cancelled'];

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
