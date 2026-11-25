import { and, eq, lte, ne, sql } from 'drizzle-orm';
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
  return (await lockPublishedRow(tx, userId, role)).units;
}

/** `lockPublished` з межею зрізу (`last_rating_id`) — блокувальне читання, свіжий стан. */
export async function lockPublishedRow(
  tx: Tx,
  userId: number,
  role: RatingRole,
): Promise<{ units: number; lastRatingId: number | null }> {
  await tx
    .insert(publishedRatings)
    .values({ userId, role })
    .onDuplicateKeyUpdate({ set: { units: sql`${publishedRatings.units}` } });
  const [row] = await tx
    .select({ units: publishedRatings.units, lastRatingId: publishedRatings.lastRatingId })
    .from(publishedRatings)
    .where(and(eq(publishedRatings.userId, userId), eq(publishedRatings.role, role)))
    .for('update');
  return row!;
}

/**
 * Перевірка пачки й публікація зрізу рейтингу. Викликається в транзакції збереження оцінки
 * (після INSERT); `true` — зріз опубліковано (після коміту — подія `rating.published`).
 * Поточні одиниці — за всіма не-відмовами (людина, роль), крім анульованих модерацією; публікація, якщо одиниць ≥ 5 і
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
    .where(counted(userId, role));
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

/** Оцінки, що входять у рейтинг (людина, роль): не відмови й не анульовані модерацією. */
function counted(userId: number, role: RatingRole) {
  return and(
    eq(ratings.rateeId, userId),
    eq(ratings.role, role),
    eq(ratings.declined, false),
    ne(ratings.moderated, 'cancelled'),
  );
}

/**
 * Негайна перепублікація зрізу (людина, роль) після анулювання оцінки модератором — у
 * транзакції дії. Перераховує лише оцінки в межах уже опублікованого зрізу (`id ≤
 * last_rating_id`), без анульованих: нові, ще не опубліковані оцінки чекають своєї пачки, тож
 * момент перепублікації (дія модератора) не розкриває нічого про нових оцінювачів. Читання —
 * блокувальні (лок зрізу, оцінки FOR SHARE): стан свіжий, навіть якщо знімок транзакції
 * зафіксовано раніше. Менше 5 одиниць — зріз ховається (`overall` NULL), але межа й лічильник
 * одиниць лишаються базою: наступна публікація, як і завжди, — лише після 5 нових одиниць.
 * Зрізу ще не було — нічого не робить. Повертає `true`, якщо зріз змінено.
 */
export async function republish(tx: Tx, userId: number, role: RatingRole): Promise<boolean> {
  const { lastRatingId: boundary } = await lockPublishedRow(tx, userId, role);
  if (boundary === null) return false;
  const rows = await tx
    .select({
      raterId: ratings.raterId,
      gameId: ratings.gameId,
      overall: ratings.overall,
      criteria: ratings.criteria,
    })
    .from(ratings)
    .where(and(counted(userId, role), lte(ratings.id, boundary)))
    .for('share');
  const scored = rows.filter((r) => r.overall !== null).map((r) => ({ ...r, overall: r.overall! }));
  const computed = computeRating(scored);
  const hidden = computed.units < RATING_MIN_UNITS;
  await tx
    .update(publishedRatings)
    .set({
      overall: hidden ? null : computed.overall,
      overallUnits: hidden ? 0 : computed.overallUnits,
      criteria: hidden ? null : computed.criteria,
      units: computed.units,
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
