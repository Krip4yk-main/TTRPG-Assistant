import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { GameStatus } from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  cancelPendingForGames,
  logCancelled,
  type CancelledApplication,
  type Tx,
} from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { gameApplications, gameMembers, games } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import {
  applicationsChanged,
  closeMembersRoom,
  membersChanged,
  sessionsChanged,
} from '../realtime/game-rooms.js';
import {
  cancelFutureSessions,
  logSessionsCancelled,
  type CancelledSession,
} from '../sessions/materialize.js';

/**
 * Каскад виходу користувача з усього активного — спільний для видалення акаунта
 * (`account_deleted`) і глобального бану (`banned_by_admin`): активні ігри майстра скасовуються
 * (гравці отримують звичайне сповіщення про скасування), власні `pending`-заявки
 * відкликаються, з активних ігор (`recruiting`/`started`) користувач виходить. Після кінця бану
 * нічого не відновлюється.
 *
 * Порядок блокувань той самий, що в заявках/затвердженні: рядки ігор → рядок користувача →
 * заявки/членства (див. `lockUser` у applications.rules.ts). Тож:
 * 1. `leaveCandidates` — до транзакції (чи до першого блокування в ній): неблокувальне читання
 *    в транзакції зафіксувало б знімок REPEATABLE READ ще до блокувань;
 * 2. `lockLeaveGames` — X на рядки ігор одним запитом за зростанням id;
 * 3. викликач блокує рядок `users` (X);
 * 4. `runLeaveCascade` — решта в тій самій транзакції;
 * 5. після коміту — `logLeaveCascade` (події → сповіщення) і `pingLeaveCascade`.
 */
export type LeaveReason = 'account_deleted' | 'banned_by_admin';

/** Ігри майстра, які каскад скасовує. */
export const ACTIVE_GAME_STATUSES: GameStatus[] = ['draft', 'recruiting', 'started', 'paused'];

type DbLike = Db | Tx;
type GameRef = { id: number; status: GameStatus };

export interface LeaveCascadeResult {
  cancelledGameIds: GameRef[];
  cancelledApps: CancelledApplication[];
  cancelledSessions: CancelledSession[];
  withdrawn: { id: number; gameId: number }[];
  leftGameIds: number[];
}

/**
 * Ігри, які треба заблокувати до рядка користувача: свої активні (скасуємо) і ті, куди є своя
 * `pending`-заявка (відкличемо). Тоді два одночасні каскади з перехресними заявками
 * серіалізуються на рядках ігор, а не зустрічаються по колу на заявках.
 */
export async function leaveCandidates(db: DbLike, userId: number): Promise<number[]> {
  const own = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.gmUserId, userId), inArray(games.status, ACTIVE_GAME_STATUSES)));
  const appliedTo = await db
    .select({ id: gameApplications.gameId })
    .from(gameApplications)
    .where(and(eq(gameApplications.userId, userId), eq(gameApplications.status, 'pending')));
  return [...new Set([...own, ...appliedTo].map((g) => g.id))];
}

/** X-блокування рядків ігор (за зростанням id); повертає свої активні ігри майстра. */
export async function lockLeaveGames(tx: Tx, userId: number, ids: number[]): Promise<GameRef[]> {
  if (ids.length === 0) return [];
  const locked = await tx
    .select({ id: games.id, status: games.status, gmUserId: games.gmUserId })
    .from(games)
    .where(inArray(games.id, ids))
    .orderBy(asc(games.id))
    .for('update');
  return locked
    .filter((g) => g.gmUserId === userId && ACTIVE_GAME_STATUSES.includes(g.status))
    .map(({ id, status }) => ({ id, status }));
}

/**
 * Каскад у транзакції; рядок користувача вже під X. `active` — від `lockLeaveGames`.
 * Склад завершених/скасованих ігор лишається (історія інших гравців).
 */
export async function runLeaveCascade(
  tx: Tx,
  userId: number,
  active: GameRef[],
  now: Date,
  reason: LeaveReason,
): Promise<LeaveCascadeResult> {
  const own = [...active];
  // Гра, створена між читанням кандидатів і транзакцією, теж скасовується: після X на `users`
  // дочитуємо свої активні ігри блокувальним читанням (свої рядки ігор не беруть ні заявки, ні
  // затвердження чужих користувачів у зворотному порядку).
  const late = await tx
    .select({ id: games.id, status: games.status })
    .from(games)
    .where(and(eq(games.gmUserId, userId), inArray(games.status, ACTIVE_GAME_STATUSES)))
    .for('update');
  for (const g of late) if (!own.some((a) => a.id === g.id)) own.push(g);
  // Блокувальне читання лише членств (без рядків ігор — їх не блокуємо поза порядком): бачить і
  // членство, закомічене затвердженням, поки каскад чекав на рядок гри (знімок транзакції міг
  // застаріти). Статус гри — звичайним читанням: потрібні лише активні ігри. Членство не
  // видаляється, а завершується: присутність на сесіях лишається в історії.
  const open = await tx
    .select({ id: gameMembers.id, gameId: gameMembers.gameId })
    .from(gameMembers)
    .where(and(eq(gameMembers.userId, userId), isNull(gameMembers.leftAt)))
    .for('update');
  const activeGames = open.length
    ? new Set(
        (
          await tx
            .select({ id: games.id })
            .from(games)
            .where(
              and(
                inArray(
                  games.id,
                  open.map((m) => m.gameId),
                ),
                inArray(games.status, ['recruiting', 'started', 'paused']),
              ),
            )
        ).map((g) => g.id),
      )
    : new Set<number>();
  const memberships = open.filter((m) => activeGames.has(m.gameId));
  if (memberships.length) {
    await tx
      .update(gameMembers)
      .set({ leftAt: now, leftReason: reason })
      .where(
        and(
          inArray(
            gameMembers.id,
            memberships.map((m) => m.id),
          ),
          isNull(gameMembers.leftAt),
        ),
      );
  }
  const withdrawn = await tx
    .select({ id: gameApplications.id, gameId: gameApplications.gameId })
    .from(gameApplications)
    .where(and(eq(gameApplications.userId, userId), eq(gameApplications.status, 'pending')))
    .for('update');
  if (withdrawn.length) {
    await tx
      .update(gameApplications)
      .set({ status: 'withdrawn', decidedAt: now })
      .where(
        and(
          inArray(
            gameApplications.id,
            withdrawn.map((w) => w.id),
          ),
          eq(gameApplications.status, 'pending'),
        ),
      );
  }
  const ownIds = own.map((g) => g.id);
  if (ownIds.length) {
    await tx
      .update(games)
      .set({ status: 'cancelled', cancelledAt: now })
      .where(inArray(games.id, ownIds));
  }
  const cancelledApps = await cancelPendingForGames(tx, ownIds, now);
  const cancelledSessions = await cancelFutureSessions(tx, ownIds, now, 'game_cancelled');
  return {
    cancelledGameIds: own,
    cancelledApps,
    cancelledSessions,
    withdrawn,
    leftGameIds: memberships.map((m) => m.gameId),
  };
}

/** Події каскаду (після коміту): з них — звичайні сповіщення гравцям і майстрам. */
export async function logLeaveCascade(
  db: Db,
  userId: number,
  r: LeaveCascadeResult,
  reason: LeaveReason,
): Promise<void> {
  for (const g of r.cancelledGameIds) {
    await logEvent(db, {
      type: 'game.cancelled',
      userId,
      entityType: 'game',
      entityId: g.id,
      payload: { from: g.status, to: 'cancelled', reason },
    });
  }
  await logCancelled(db, r.cancelledApps, 'application.cancelled_game');
  await logSessionsCancelled(db, userId, r.cancelledSessions, 'game_cancelled');
  for (const w of r.withdrawn) {
    await logEvent(db, {
      type: 'application.withdrawn',
      userId,
      entityType: 'application',
      entityId: w.id,
      payload: { gameId: w.gameId, reason },
    });
  }
  for (const gameId of r.leftGameIds) {
    await logEvent(db, {
      type: 'member.left',
      userId,
      entityType: 'game',
      entityId: gameId,
      payload: { gameId, reason },
    });
  }
}

/** Пінги змін після каскаду (сокети самого користувача вже розірвано). */
export async function pingLeaveCascade(
  deps: Pick<AppDeps, 'db'> & Partial<Pick<AppDeps, 'realtime'>>,
  userId: number,
  r: LeaveCascadeResult,
): Promise<void> {
  if (!deps.realtime) return;
  const rt = deps;
  for (const gameId of r.leftGameIds) membersChanged(rt, gameId, [userId]);
  for (const g of r.cancelledGameIds) {
    sessionsChanged(rt, g.id);
    closeMembersRoom(rt, g.id);
  }
  for (const a of r.cancelledApps) applicationsChanged(rt, a.gameId, [a.userId]);
  const gameIds = [...new Set(r.withdrawn.map((w) => w.gameId))];
  if (gameIds.length === 0) return;
  try {
    const gms = await deps.db
      .select({ id: games.id, gmUserId: games.gmUserId })
      .from(games)
      .where(inArray(games.id, gameIds));
    for (const g of gms) applicationsChanged(rt, g.id, [g.gmUserId]);
  } catch (err) {
    console.error('[realtime] leave-cascade pings failed', err);
  }
}
