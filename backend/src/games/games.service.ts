import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import {
  expandOccurrences,
  GAME_LOCKED_AFTER_PUBLISH,
  gameInputSchema,
  gamePatchSchema,
  meetsAgeRating,
  type GameAction,
  type GameCardDto,
  type GameDto,
  type GameInput,
  type GameStatus,
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
  gameSystems,
  genres,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import { toCardView, toGameView, viewerAge, type Viewer } from './games.visibility.js';

type GameRow = typeof games.$inferSelect;

export interface Loaded {
  row: GameRow;
  gm: GameDto['gm'];
  systemName: string | null;
  memberCount: number;
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
      inArray(
        gameMembers.gameId,
        rows.map((r) => r.row.id),
      ),
    )
    .groupBy(gameMembers.gameId);
  const byGame = new Map(counts.map((c) => [c.gameId, c.n]));
  return rows.map((r) => ({
    row: r.row,
    gm: { publicId: r.gmPublicId, nickname: r.gmNickname, avatarUrl: r.gmAvatarUrl },
    systemName: r.systemName,
    memberCount: byGame.get(r.row.id) ?? 0,
  }));
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

/** Найближча сесія, що починається не раніше `now`; для завершених/скасованих — `null`. */
function nextSessionAt(row: GameRow, now: Date): string | null {
  if (row.status === 'finished' || row.status === 'cancelled') return null;
  const to = new Date(Math.max(now.getTime(), row.startsAt.getTime()) + NEXT_SESSION_HORIZON_MS);
  const [first] = expandOccurrences(
    {
      startsAt: row.startsAt.toISOString(),
      durationMinutes: row.durationMinutes,
      recurrence: row.recurrence,
      weekdays: row.weekdays,
      timezone: row.timezone,
    },
    now,
    to,
  );
  return first ? first.start.toISOString() : null;
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
    nextSessionAt: nextSessionAt(l.row, now),
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
    nextSessionAt: nextSessionAt(r, now),
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
async function viewerById(deps: AppDeps, userId: number): Promise<Viewer> {
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
  const l = await loadOwned(deps, userId, id);
  const { row } = l;
  if (row.status === 'finished' || row.status === 'cancelled') {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  const current = toInput(row, await warningIdsOf(deps, id));
  if (row.status !== 'draft') {
    for (const field of GAME_LOCKED_AFTER_PUBLISH) {
      if (patch[field] !== undefined && patch[field] !== current[field]) {
        throw new AppError(409, 'GAME_FIELD_LOCKED', { field });
      }
    }
  }
  const next = gameInputSchema(row.timezone).parse({ ...current, ...patch });
  const now = new Date();
  assertGmAge(await loadGm(deps, userId), next, now);
  await assertCatalogRefs(deps, next, current);
  if (
    row.status === 'recruiting' &&
    next.startsAt !== current.startsAt &&
    new Date(next.startsAt) <= now
  ) {
    throw new AppError(422, 'GAME_IN_PAST');
  }
  await patchHooks.beforeWrite?.(id);
  await db.transaction(async (tx) => {
    // Умова за прочитаним статусом: якщо гру тим часом опублікували/скасували, заблоковані
    // поля чи завершена гра не змінюються — 409, транзакція відкочується.
    const [res] = await tx
      .update(games)
      .set(columns(next))
      .where(and(eq(games.id, id), eq(games.status, row.status)));
    if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    if (patch.contentWarningIds !== undefined) {
      await tx.delete(gameContentWarnings).where(eq(gameContentWarnings.gameId, id));
      if (next.contentWarningIds.length) {
        await tx
          .insert(gameContentWarnings)
          .values(next.contentWarningIds.map((warningId) => ({ gameId: id, warningId })));
      }
    }
  });
  await logEvent(db, {
    type: 'game.updated',
    userId,
    entityType: 'game',
    entityId: id,
    payload: {
      fields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
    },
  });
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

const EVENT: Record<GameAction, string> = {
  publish: 'game.published',
  start: 'game.started',
  finish: 'game.finished',
  cancel: 'game.cancelled',
};

export async function transitionGame(
  deps: AppDeps,
  userId: number,
  id: number,
  action: GameAction,
): Promise<GameDto> {
  const { db } = deps;
  const t = TRANSITIONS[action];
  const { row } = await loadOwned(deps, userId, id);
  if (!t.from.includes(row.status)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const now = new Date();
  if (action === 'publish' && row.startsAt <= now) throw new AppError(422, 'GAME_IN_PAST');
  // Умова за поточним статусом захищає від гонки двох переходів.
  const [res] = await db
    .update(games)
    .set({ status: t.to, [t.stamp]: now })
    .where(and(eq(games.id, id), eq(games.status, row.status)));
  if (res.affectedRows === 0) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  await logEvent(db, {
    type: EVENT[action],
    userId,
    entityType: 'game',
    entityId: id,
    payload: { from: row.status, to: t.to },
  });
  return gmView(deps, id);
}

export async function getGameView(deps: AppDeps, viewer: Viewer, id: number): Promise<GameViewDto> {
  const l = await loadOne(deps, id);
  if (!l) throw new AppError(404, 'NOT_FOUND');
  let isMember = false;
  if (viewer) {
    const [m] = await deps.db
      .select({ id: gameMembers.gameId })
      .from(gameMembers)
      .where(and(eq(gameMembers.gameId, id), eq(gameMembers.userId, viewer.userId)));
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

/** Статуси, що показуються в історії ігор профілю. */
const PROFILE_STATUSES: GameStatus[] = ['recruiting', 'started', 'finished'];

/** Ігри користувача для публічного профілю (без чернеток і скасованих). */
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
  const visible = inArray(games.status, PROFILE_STATUSES);
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
