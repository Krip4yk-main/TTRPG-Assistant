import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { leaveGameInputSchema, type BlacklistEntryDto, type MemberDto } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { cancelPendingOfUser, type Tx } from '../applications/applications.rules.js';
import {
  calendarPinnedGames,
  gameBans,
  gameMembers,
  games,
  gmBlacklist,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { applicationsChanged, membersChanged } from '../realtime/game-rooms.js';

type GameRow = typeof games.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** Учасниками керують, поки гра набирає або йде. */
const isRunning = (g: GameRow): boolean => g.status === 'recruiting' || g.status === 'started';

async function findGame(deps: AppDeps, gameId: number): Promise<GameRow> {
  const [g] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  return g;
}

/** Гра, видима глядачеві: прихована від не-майстра → 404. */
function assertVisible(g: GameRow, userId: number): void {
  if (g.gmUserId !== userId && isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
}

/** Гра, якою керує майстер: прихована чужа → 404, інша чужа → 403. */
function assertGm(g: GameRow, userId: number): void {
  assertVisible(g, userId);
  if (g.gmUserId !== userId) throw new AppError(403, 'FORBIDDEN');
}

/** Завершене членство знімає ручне закріплення гри в календарі. */
async function unpinGame(tx: Tx, userId: number, gameId: number): Promise<void> {
  await tx
    .delete(calendarPinnedGames)
    .where(and(eq(calendarPinnedGames.userId, userId), eq(calendarPinnedGames.gameId, gameId)));
}

async function activeMembership(tx: Tx | AppDeps['db'], gameId: number, userId: number) {
  const [m] = await tx
    .select()
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, gameId),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  return m ?? null;
}

/** Живий (не видалений) користувач за публічним id; інакше 404. */
async function userByPublicId(deps: AppDeps, publicId: string): Promise<UserRow> {
  const [u] = await deps.db.select().from(users).where(eq(users.publicId, publicId));
  if (!u || u.status === 'deleted') throw new AppError(404, 'NOT_FOUND');
  return u;
}

/** Рядок гри під X-блокуванням (порядок: гра → користувач → заявки/членства). */
async function lockGameX(tx: Tx, gameId: number): Promise<GameRow> {
  const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for('update');
  if (!g) throw new AppError(404, 'NOT_FOUND');
  return g;
}

// ---------- склад ----------

/** Склад гри — майстру й активним учасникам; іншим (зокрема колишнім) — 403. */
export async function listMembers(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<MemberDto[]> {
  const g = await findGame(deps, gameId);
  assertVisible(g, userId);
  if (g.gmUserId !== userId && !(await activeMembership(deps.db, gameId, userId))) {
    throw new AppError(403, 'NOT_A_MEMBER');
  }
  const rows = await deps.db
    .select({
      publicId: users.publicId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      joinedAt: gameMembers.joinedAt,
    })
    .from(gameMembers)
    .innerJoin(users, eq(users.id, gameMembers.userId))
    .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)))
    .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id));
  return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
}

// ---------- вихід ----------

/** Вихід учасника: «для майстра» ≥ 10 символів; «для адміністрації» за замовчуванням — те саме. */
export async function leaveGame(
  deps: AppDeps,
  userId: number,
  gameId: number,
  body: unknown,
): Promise<void> {
  const input = leaveGameInputSchema.parse(body);
  const g0 = await findGame(deps, gameId);
  assertVisible(g0, userId);
  await deps.db.transaction(async (tx) => {
    const [g] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
    if (!g) throw new AppError(404, 'NOT_FOUND');
    const m = await activeMembership(tx, gameId, userId);
    if (!m) throw new AppError(403, 'NOT_A_MEMBER');
    if (!isRunning(g)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    const [res] = await tx
      .update(gameMembers)
      .set({
        leftAt: new Date(),
        leftReason: 'left',
        leaveNoteGm: input.noteForGm,
        leaveNoteAdmin: input.noteForAdmin,
      })
      .where(and(eq(gameMembers.id, m.id), isNull(gameMembers.leftAt)));
    if (res.affectedRows === 0) throw new AppError(403, 'NOT_A_MEMBER');
    await unpinGame(tx, userId, gameId);
  });
  await logEvent(deps.db, {
    type: 'member.left',
    userId,
    entityType: 'game',
    entityId: gameId,
    payload: { gameId },
  });
  membersChanged(deps, gameId, [userId]);
}

// ---------- дії майстра ----------

/** «Виключити»: членство завершується (`kicked`); гравець може подати заявку знову. */
export async function kickMember(
  deps: AppDeps,
  gmUserId: number,
  gameId: number,
  publicId: string,
): Promise<void> {
  assertGm(await findGame(deps, gameId), gmUserId);
  const target = await userByPublicId(deps, publicId);
  await deps.db.transaction(async (tx) => {
    const g = await lockGameX(tx, gameId);
    if (!isRunning(g)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    const [res] = await tx
      .update(gameMembers)
      .set({ leftAt: new Date(), leftReason: 'kicked' })
      .where(
        and(
          eq(gameMembers.gameId, gameId),
          eq(gameMembers.userId, target.id),
          isNull(gameMembers.leftAt),
        ),
      );
    if (res.affectedRows === 0) throw new AppError(404, 'NOT_FOUND');
    await unpinGame(tx, target.id, gameId);
  });
  await logEvent(deps.db, {
    type: 'member.kicked',
    userId: gmUserId,
    entityType: 'game',
    entityId: gameId,
    payload: { gameId, memberId: target.id },
  });
  membersChanged(deps, gameId, [target.id]);
}

/**
 * «Забанити в цій грі»: запис у `game_bans` (блокує нові заявки), активне членство
 * завершується (`banned`), `pending`-заявка скасовується (`banned`). Рядок гри — під
 * X-блокуванням, а затвердження бере на нього FOR SHARE і перевіряє `game_bans`, тож
 * забанений не стане учасником через паралельне затвердження. Бан можливий і для
 * не-учасника (наприклад, автора заявки).
 */
export async function banMember(
  deps: AppDeps,
  gmUserId: number,
  gameId: number,
  publicId: string,
): Promise<void> {
  assertGm(await findGame(deps, gameId), gmUserId);
  const target = await userByPublicId(deps, publicId);
  if (target.id === gmUserId) throw new AppError(400, 'VALIDATION');
  const now = new Date();
  const { banned, wasMember, cancelled } = await deps.db.transaction(async (tx) => {
    const g = await lockGameX(tx, gameId);
    if (!isRunning(g)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    const [ins] = await tx.insert(gameBans).ignore().values({ gameId, userId: target.id });
    const [res] = await tx
      .update(gameMembers)
      .set({ leftAt: now, leftReason: 'banned' })
      .where(
        and(
          eq(gameMembers.gameId, gameId),
          eq(gameMembers.userId, target.id),
          isNull(gameMembers.leftAt),
        ),
      );
    const cancelled = await cancelPendingOfUser(tx, gameId, target.id, 'banned', now);
    await unpinGame(tx, target.id, gameId);
    return { banned: ins.affectedRows > 0, wasMember: res.affectedRows > 0, cancelled };
  });
  // Повторний бан (рядок уже був) нічого не змінює — без події, тож і без сповіщення.
  if (!banned && !wasMember && cancelled.length === 0) return;
  await logEvent(deps.db, {
    type: 'member.banned',
    userId: gmUserId,
    entityType: 'game',
    entityId: gameId,
    payload: {
      gameId,
      memberId: target.id,
      wasMember,
      cancelledApplicationIds: cancelled.map((c) => c.id),
    },
  });
  if (wasMember) membersChanged(deps, gameId, [target.id]);
  if (cancelled.length) applicationsChanged(deps, gameId, [gmUserId, target.id]);
}

// ---------- чорний список майстра ----------

export async function listBlacklist(deps: AppDeps, gmUserId: number): Promise<BlacklistEntryDto[]> {
  const rows = await deps.db
    .select({
      publicId: users.publicId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      createdAt: gmBlacklist.createdAt,
    })
    .from(gmBlacklist)
    .innerJoin(users, eq(users.id, gmBlacklist.userId))
    .where(eq(gmBlacklist.gmUserId, gmUserId))
    .orderBy(desc(gmBlacklist.createdAt), desc(gmBlacklist.userId));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * Додає до чорного списку (ідемпотентно): блокує нові заявки на всі ігри майстра, але не
 * виключає з поточних — виключення окремою дією (рішення власника).
 */
export async function addToBlacklist(
  deps: AppDeps,
  gmUserId: number,
  publicId: string,
): Promise<BlacklistEntryDto> {
  const target = await userByPublicId(deps, publicId);
  if (target.id === gmUserId) throw new AppError(400, 'VALIDATION');
  const [res] = await deps.db.insert(gmBlacklist).ignore().values({ gmUserId, userId: target.id });
  if (res.affectedRows > 0) {
    await logEvent(deps.db, {
      type: 'gm.blacklisted',
      userId: gmUserId,
      entityType: 'user',
      entityId: target.id,
    });
  }
  const [row] = await deps.db
    .select({ createdAt: gmBlacklist.createdAt })
    .from(gmBlacklist)
    .where(and(eq(gmBlacklist.gmUserId, gmUserId), eq(gmBlacklist.userId, target.id)));
  return {
    publicId: target.publicId,
    nickname: target.nickname,
    avatarUrl: target.avatarUrl,
    createdAt: (row?.createdAt ?? new Date()).toISOString(),
  };
}

export async function removeFromBlacklist(
  deps: AppDeps,
  gmUserId: number,
  publicId: string,
): Promise<void> {
  const [u] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, publicId));
  if (!u) throw new AppError(404, 'NOT_FOUND');
  const [res] = await deps.db
    .delete(gmBlacklist)
    .where(and(eq(gmBlacklist.gmUserId, gmUserId), eq(gmBlacklist.userId, u.id)));
  if (res.affectedRows === 0) throw new AppError(404, 'NOT_FOUND');
  await logEvent(deps.db, {
    type: 'gm.unblacklisted',
    userId: gmUserId,
    entityType: 'user',
    entityId: u.id,
  });
}
