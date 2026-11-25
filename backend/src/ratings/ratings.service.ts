import { eq } from 'drizzle-orm';
import {
  criteriaForRole,
  ratingInputSchema,
  type RatingInput,
  type RatingRole,
  type RatingTargetDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { isDuplicateKey } from '../db/errors.js';
import { games, ratings, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import {
  accessRatingGame,
  assertSessionOfGame,
  candidateSetsFor,
  isWindowOpen,
  ratingRole,
} from './ratings.eligibility.js';

/**
 * Перевірка пачки й публікація зрізу рейтингу (Task 3). Викликається в транзакції збереження
 * оцінки; `true` — зріз опубліковано (після коміту — подія `rating.published`).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- заглушка до Task 3, підпис фіксований
export async function maybePublish(tx: Tx, userId: number, role: RatingRole): Promise<boolean> {
  return false;
}

/**
 * Збереження оцінки або відмови. Гра невідома/прихована → 404; ціль — не активний акаунт,
 * сам оцінювач або не з наборів `ratingTargets` → 403 `RATING_NOT_ALLOWED`; критерій не з
 * набору ролі цілі → 400 `RATING_CRITERIA_INVALID`; вікно закрите → 409
 * `RATING_WINDOW_CLOSED`; уже оцінено/відмовлено → 409 `RATING_EXISTS`. `kind` виводиться з
 * `sessionId`. Транзакція: гра FOR SHARE (як вихід/завершення сесії; виключення й бан беруть
 * X) → перевірка цілі тією ж логікою, що й `ratingTargets` → INSERT → `maybePublish`.
 */
export async function submitRating(
  deps: AppDeps,
  raterId: number,
  gameId: number,
  input: RatingInput,
  now: Date = new Date(),
): Promise<RatingTargetDto> {
  const parsed = ratingInputSchema.parse(input);
  const { db } = deps;
  const { game } = await accessRatingGame(db, raterId, gameId);
  const sessionId = parsed.sessionId ?? null;
  if (sessionId !== null) await assertSessionOfGame(db, gameId, sessionId);
  const [ratee] = await db
    .select({
      id: users.id,
      publicId: users.publicId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      status: users.status,
    })
    .from(users)
    .where(eq(users.publicId, parsed.rateeId));
  if (!ratee || ratee.status !== 'active' || ratee.id === raterId) {
    throw new AppError(403, 'RATING_NOT_ALLOWED');
  }
  const role = ratingRole(game.gmUserId, raterId, ratee.id);
  const scored = 'declined' in parsed ? null : parsed;
  const criteria = scored?.criteria ?? {};
  const allowed = criteriaForRole(role);
  if (Object.keys(criteria).some((k) => !(allowed as readonly string[]).includes(k))) {
    throw new AppError(400, 'RATING_CRITERIA_INVALID');
  }

  const { closesAt, published } = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: games.id,
        gmUserId: games.gmUserId,
        kind: games.kind,
        status: games.status,
        publishedAt: games.publishedAt,
        finishedAt: games.finishedAt,
        cancelledAt: games.cancelledAt,
      })
      .from(games)
      .where(eq(games.id, gameId))
      .for('share');
    if (!locked) throw new AppError(404, 'NOT_FOUND');
    const sets = await candidateSetsFor(tx, locked, raterId, now);
    const set = sets.find((s) => s.sessionId === sessionId);
    if (!set || !set.rateeIds.includes(ratee.id)) throw new AppError(403, 'RATING_NOT_ALLOWED');
    if (!isWindowOpen(set.closesAt, now)) throw new AppError(409, 'RATING_WINDOW_CLOSED');
    try {
      await tx.insert(ratings).values({
        raterId,
        rateeId: ratee.id,
        gameId,
        sessionId,
        kind: sessionId === null ? 'final' : 'session',
        role,
        declined: !scored,
        overall: scored?.overall ?? null,
        criteria: scored && Object.keys(criteria).length ? criteria : null,
        comment: scored?.comment ?? null,
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError(409, 'RATING_EXISTS');
      throw err;
    }
    const published = await maybePublish(tx, ratee.id, role);
    return { closesAt: set.closesAt, published };
  });

  // Без оцінювача: подія не повинна розкривати, хто кого оцінив.
  await logEvent(db, {
    type: 'rating.created',
    entityType: 'game',
    entityId: gameId,
    payload: { gameId },
  });
  if (published) {
    await logEvent(db, {
      type: 'rating.published',
      entityType: 'user',
      entityId: ratee.id,
      payload: { userId: ratee.id, role },
    });
  }
  return {
    publicId: ratee.publicId,
    nickname: ratee.nickname ?? '',
    avatarUrl: ratee.avatarUrl,
    role,
    state: scored ? 'rated' : 'declined',
    closesAt: closesAt?.toISOString() ?? null,
  };
}
