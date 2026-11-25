import { and, eq, sql } from 'drizzle-orm';
import {
  criteriaForRole,
  RATING_BATCH_UNITS,
  RATING_MIN_UNITS,
  ratingInputSchema,
  type RatingInput,
  type RatingRole,
  type RatingTargetDto,
  type UserRatingsDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { isDuplicateKey } from '../db/errors.js';
import { games, publishedRatings, ratings, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import { computeRating, toPublishedDto } from './ratings.aggregate.js';
import {
  accessRatingGame,
  assertSessionOfGame,
  candidateSetsFor,
  isWindowOpen,
  ratingRole,
} from './ratings.eligibility.js';

/**
 * Блокує рядок зрізу (`published_ratings`) для (людина, роль) — X-лок до кінця транзакції;
 * відсутній рядок створюється заготовкою (`units` = 0, `overall` NULL). INSERT … ON DUPLICATE
 * KEY UPDATE бере X-лок і на вже наявному рядку, тож паралельні вставки заготовки не падають
 * з дублем і не впираються в дедлок апгрейду S→X (як було б з «INSERT, дубль → SELECT FOR
 * UPDATE»). Повертає поточну кількість опублікованих одиниць.
 */
export async function lockPublished(tx: Tx, userId: number, role: RatingRole): Promise<number> {
  await tx
    .insert(publishedRatings)
    .values({ userId, role })
    .onDuplicateKeyUpdate({ set: { units: sql`${publishedRatings.units}` } });
  const [row] = await tx
    .select({ units: publishedRatings.units })
    .from(publishedRatings)
    .where(and(eq(publishedRatings.userId, userId), eq(publishedRatings.role, role)))
    .for('update');
  return row!.units;
}

/**
 * Перевірка пачки й публікація зрізу рейтингу. Викликається в транзакції збереження оцінки
 * (після INSERT); `true` — зріз опубліковано (після коміту — подія `rating.published`).
 * Поточні одиниці — за всіма не-відмовами (людина, роль); публікація, якщо одиниць ≥ 5 і
 * з'явилось ≥ 5 нових від останнього зрізу (без зрізу — 0, тож перша — рівно від 5).
 * Серіалізація паралельних оцінок — лок рядка зрізу (`lockPublished`); `submitRating` бере
 * його ДО першого неблокуючого читання, щоб знімок транзакції бачив усі оцінки, закомічені
 * попереднім власником лока.
 */
export async function maybePublish(tx: Tx, userId: number, role: RatingRole): Promise<boolean> {
  const publishedUnits = await lockPublished(tx, userId, role);
  const rows = await tx
    .select({
      id: ratings.id,
      raterId: ratings.raterId,
      gameId: ratings.gameId,
      overall: ratings.overall,
      criteria: ratings.criteria,
    })
    .from(ratings)
    .where(and(eq(ratings.rateeId, userId), eq(ratings.role, role), eq(ratings.declined, false)));
  const scored = rows.filter((r) => r.overall !== null).map((r) => ({ ...r, overall: r.overall! }));
  const computed = computeRating(scored);
  if (computed.units < RATING_MIN_UNITS) return false;
  if (computed.units - publishedUnits < RATING_BATCH_UNITS) return false;
  const lastRatingId = scored.reduce((m, r) => Math.max(m, r.id), 0);
  await tx
    .update(publishedRatings)
    .set({
      overall: computed.overall,
      overallUnits: computed.overallUnits,
      criteria: computed.criteria,
      units: computed.units,
      lastRatingId,
      publishedAt: new Date(),
    })
    .where(and(eq(publishedRatings.userId, userId), eq(publishedRatings.role, role)));
  return true;
}

/** Опубліковані рейтинги людини (профіль): лише зрізи; менше 5 одиниць — `null`. */
export async function userRatings(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
): Promise<UserRatingsDto> {
  const rows = await deps.db
    .select({
      role: publishedRatings.role,
      overall: publishedRatings.overall,
      units: publishedRatings.units,
      criteria: publishedRatings.criteria,
    })
    .from(publishedRatings)
    .where(eq(publishedRatings.userId, userId));
  const by = new Map(rows.map((r) => [r.role, r]));
  return {
    gm: toPublishedDto(by.get('gm')),
    playerFromGm: toPublishedDto(by.get('player_from_gm')),
    playerFromPlayer: toPublishedDto(by.get('player_from_player')),
  };
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
        title: games.title,
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
    // Лок зрізу — до першого неблокуючого SELECT (див. `maybePublish`).
    await lockPublished(tx, ratee.id, role);
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
