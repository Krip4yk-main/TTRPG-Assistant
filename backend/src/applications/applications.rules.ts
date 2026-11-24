import { and, eq, inArray, isNull } from 'drizzle-orm';
import { meetsAgeRating, type AgeRating } from '@nri/shared';
import type { Db } from '../db/client.js';
import { gameApplications, gameMembers, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import { viewerAge } from '../games/games.visibility.js';

/** Транзакція drizzle (той самий API, що й `Db`). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Скасована `pending`-заявка: для подій після коміту. */
export interface CancelledApplication {
  id: number;
  gameId: number;
  userId: number;
}

const RATING_RANK: Record<AgeRating, number> = { none: 0, '18+': 1, '21+': 2 };

export const isRatingRaised = (from: AgeRating, to: AgeRating): boolean =>
  RATING_RANK[to] > RATING_RANK[from];

async function cancelPending(
  tx: Tx,
  rows: CancelledApplication[],
  reason: 'age_rating' | 'game_cancelled',
  now: Date,
): Promise<CancelledApplication[]> {
  if (rows.length === 0) return [];
  await tx
    .update(gameApplications)
    .set({ status: 'cancelled', cancelReason: reason, decidedAt: now })
    .where(
      and(
        inArray(
          gameApplications.id,
          rows.map((r) => r.id),
        ),
        eq(gameApplications.status, 'pending'),
      ),
    );
  return rows;
}

/** Скасовує всі `pending`-заявки на ці ігри (`game_cancelled`). Викликати в транзакції. */
export async function cancelPendingForGames(
  tx: Tx,
  gameIds: number[],
  now: Date = new Date(),
): Promise<CancelledApplication[]> {
  if (gameIds.length === 0) return [];
  const rows = await tx
    .select({
      id: gameApplications.id,
      gameId: gameApplications.gameId,
      userId: gameApplications.userId,
    })
    .from(gameApplications)
    .where(and(inArray(gameApplications.gameId, gameIds), eq(gameApplications.status, 'pending')))
    .for('update');
  return cancelPending(tx, rows, 'game_cancelled', now);
}

/**
 * Підняття вікової позначки гри (викликати в транзакції, яка вже змінила рядок `games`,
 * тобто тримає на ньому X-блокування — заявки й затвердження беруть на гру `FOR SHARE`):
 * активний учасник, молодший за нову позначку → 409 `AGE_RATING_HAS_MINORS`; інакше
 * `pending`-заявки молодших скасовуються з причиною `age_rating`.
 */
export async function applyAgeRatingRaise(
  tx: Tx,
  gameId: number,
  rating: AgeRating,
  now: Date = new Date(),
): Promise<CancelledApplication[]> {
  const fails = (u: { userId: number; birthDate: string | null; timezone: string }) =>
    !meetsAgeRating(viewerAge(u, now), rating);
  const members = await tx
    .select({ userId: users.id, birthDate: users.birthDate, timezone: users.timezone })
    .from(gameMembers)
    .innerJoin(users, eq(users.id, gameMembers.userId))
    .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)));
  if (members.some(fails)) throw new AppError(409, 'AGE_RATING_HAS_MINORS');
  const pending = await tx
    .select({
      id: gameApplications.id,
      gameId: gameApplications.gameId,
      userId: gameApplications.userId,
      birthDate: users.birthDate,
      timezone: users.timezone,
    })
    .from(gameApplications)
    .innerJoin(users, eq(users.id, gameApplications.userId))
    .where(and(eq(gameApplications.gameId, gameId), eq(gameApplications.status, 'pending')))
    .for('update');
  const minors = pending
    .filter(fails)
    .map(({ id, gameId: g, userId }) => ({ id, gameId: g, userId }));
  return cancelPending(tx, minors, 'age_rating', now);
}

/** Події автоскасування — по одній на заявку (після коміту). */
export async function logCancelled(
  db: Db,
  rows: CancelledApplication[],
  type: 'application.cancelled_age' | 'application.cancelled_game',
): Promise<void> {
  for (const r of rows) {
    await logEvent(db, {
      type,
      userId: r.userId,
      entityType: 'application',
      entityId: r.id,
      payload: { gameId: r.gameId },
    });
  }
}
