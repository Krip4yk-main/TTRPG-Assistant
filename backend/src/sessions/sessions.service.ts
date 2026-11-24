import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  cancelSessionInputSchema,
  finishSessionInputSchema,
  rescheduleSessionInputSchema,
  type SessionDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { gameMembers, games, gameSessions, sessionAttendance, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { materializeSessions, sessionsWindow } from './materialize.js';

type GameRow = typeof games.$inferSelect;
type SessionRow = typeof gameSessions.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toSessionDto(s: SessionRow): SessionDto {
  return {
    id: s.id,
    gameId: s.gameId,
    startsAt: s.startsAt.toISOString(),
    durationMinutes: s.durationMinutes,
    status: s.status,
    origin: s.origin,
    rescheduled: s.rescheduled,
    cancelReason: s.cancelReason,
    summary: s.summary,
    doneAt: iso(s.doneAt),
  };
}

const isRunning = (g: GameRow): boolean => g.status === 'recruiting' || g.status === 'started';

async function isActiveMember(deps: AppDeps, gameId: number, userId: number): Promise<boolean> {
  const [m] = await deps.db
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, gameId),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  return Boolean(m);
}

/**
 * Сесії гри — майстру й активним учасникам (минулі 30 діб і всі майбутні); перед читанням
 * вікно матеріалізації зсувається до «зараз». Прихована гра для не-майстра → 404,
 * сторонній чи колишній учасник → 403 `NOT_A_MEMBER`.
 */
export async function listGameSessions(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<SessionDto[]> {
  const [g] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.gmUserId !== userId) {
    if (isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
    if (!(await isActiveMember(deps, gameId, userId))) throw new AppError(403, 'NOT_A_MEMBER');
  }
  const now = new Date();
  await materializeSessions(deps, gameId, now);
  const rows = await deps.db
    .select()
    .from(gameSessions)
    .where(sessionsWindow(gameId, now))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));
  return rows.map(toSessionDto);
}

// ---------- дії майстра над сесією ----------

/** Сесія й гра без блокувань — для перевірки доступу до транзакції. */
async function loadForGm(deps: AppDeps, userId: number, sessionId: number): Promise<GameRow> {
  const [r] = await deps.db
    .select({ game: games })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  if (r.game.gmUserId !== userId) {
    if (isHiddenFromNonGm(r.game)) throw new AppError(404, 'NOT_FOUND');
    throw new AppError(403, 'FORBIDDEN');
  }
  return r.game;
}

/**
 * Блокування в порядку гра (FOR SHARE) → сесія (FOR UPDATE). Гра має набирати чи йти,
 * сесія — бути `scheduled`.
 */
async function lockScheduled(
  tx: Tx,
  gameId: number,
  sessionId: number,
): Promise<{ game: GameRow; session: SessionRow }> {
  const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
  if (!game) throw new AppError(404, 'NOT_FOUND');
  if (!isRunning(game)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const [session] = await tx
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.id, sessionId))
    .for('update');
  if (!session) throw new AppError(404, 'NOT_FOUND');
  if (session.status !== 'scheduled') throw new AppError(409, 'SESSION_INVALID_STATE');
  return { game, session };
}

async function reload(deps: AppDeps, sessionId: number): Promise<SessionDto> {
  const [s] = await deps.db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!s) throw new AppError(404, 'NOT_FOUND');
  return toSessionDto(s);
}

/** Перенесення: новий час (ціла хвилина, у майбутньому), за бажанням — тривалість. */
export async function rescheduleSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = rescheduleSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  const now = new Date();
  const startsAt = new Date(input.startsAt);
  if (startsAt <= now) throw new AppError(422, 'GAME_IN_PAST');
  const from = await deps.db.transaction(async (tx) => {
    const { session } = await lockScheduled(tx, g.id, sessionId);
    await tx
      .update(gameSessions)
      .set({
        startsAt,
        rescheduled: true,
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      })
      .where(eq(gameSessions.id, sessionId));
    return session;
  });
  await logEvent(deps.db, {
    type: 'session.rescheduled',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: {
      gameId: g.id,
      from: from.startsAt.toISOString(),
      to: startsAt.toISOString(),
      durationMinutes: input.durationMinutes ?? from.durationMinutes,
    },
  });
  return reload(deps, sessionId);
}

/** Скасування окремої сесії з причиною. */
export async function cancelSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = cancelSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  await deps.db.transaction(async (tx) => {
    await lockScheduled(tx, g.id, sessionId);
    await tx
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: input.reason })
      .where(eq(gameSessions.id, sessionId));
  });
  await logEvent(deps.db, {
    type: 'session.cancelled',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: { gameId: g.id, reason: input.reason },
  });
  return reload(deps, sessionId);
}

/**
 * Завершення сесії, що вже почалась: присутність активних учасників + необов'язковий
 * підсумок (бачать лише майстер і активні учасники). Невідомий чи колишній учасник у
 * присутності → 400. Після завершення вікно матеріалізації зсувається.
 */
export async function finishSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = finishSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  const now = new Date();
  const attendance = await deps.db.transaction(async (tx) => {
    const { session } = await lockScheduled(tx, g.id, sessionId);
    if (session.startsAt > now) throw new AppError(409, 'SESSION_INVALID_STATE');
    // Під FOR SHARE гри склад не змінюється (виключення/бан беруть X).
    const publicIds = input.attendance.map((a) => a.publicId);
    const members = publicIds.length
      ? await tx
          .select({ userId: gameMembers.userId, publicId: users.publicId })
          .from(gameMembers)
          .innerJoin(users, eq(users.id, gameMembers.userId))
          .where(
            and(
              eq(gameMembers.gameId, g.id),
              isNull(gameMembers.leftAt),
              inArray(users.publicId, publicIds),
            ),
          )
      : [];
    const byPublicId = new Map(members.map((m) => [m.publicId, m.userId]));
    if (byPublicId.size !== publicIds.length) {
      throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_MEMBER' });
    }
    const rows = input.attendance.map((a) => ({
      sessionId,
      userId: byPublicId.get(a.publicId)!,
      present: a.present,
    }));
    if (rows.length) await tx.insert(sessionAttendance).values(rows);
    await tx
      .update(gameSessions)
      .set({ status: 'done', summary: input.summary, doneAt: now })
      .where(eq(gameSessions.id, sessionId));
    return rows;
  });
  await logEvent(deps.db, {
    type: 'session.done',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: {
      gameId: g.id,
      present: attendance.filter((a) => a.present).map((a) => a.userId),
      absent: attendance.filter((a) => !a.present).map((a) => a.userId),
    },
  });
  await materializeSessions(deps, g.id, now);
  return reload(deps, sessionId);
}
