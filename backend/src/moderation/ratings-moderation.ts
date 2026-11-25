import { and, desc, eq, isNotNull, lt, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  adminRatingsQuerySchema,
  ratingModerationInputSchema,
  type AdminPageDto,
  type AdminRatingDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { games, ratings, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { lockPublished, republish } from '../ratings/ratings.service.js';
import { writeLog } from './log.js';
import { assertCan, assertCanActOn, type Role } from './permissions.js';
import { actorRole } from './sanctions.service.js';

type DbLike = Db | Tx;

const raterU = alias(users, 'rating_rater');
const rateeU = alias(users, 'rating_ratee');

function ratingsQuery(db: DbLike) {
  return db
    .select({
      r: ratings,
      rater: { publicId: raterU.publicId, nickname: raterU.nickname, role: raterU.role },
      ratee: { publicId: rateeU.publicId, nickname: rateeU.nickname, role: rateeU.role },
      game: { id: games.id, title: games.title },
    })
    .from(ratings)
    .innerJoin(raterU, eq(raterU.id, ratings.raterId))
    .innerJoin(rateeU, eq(rateeU.id, ratings.rateeId))
    .innerJoin(games, eq(games.id, ratings.gameId));
}

type Row = Awaited<ReturnType<ReturnType<typeof ratingsQuery>['execute']>>[number];

/** Оцінка для персоналу; прихований текст не віддається (його бачать адмін+ у журналі). */
function toDto(row: Row): AdminRatingDto {
  const r = row.r;
  return {
    id: r.id,
    rater: row.rater,
    ratee: row.ratee,
    game: row.game,
    sessionId: r.sessionId,
    kind: r.kind,
    role: r.role,
    overall: r.overall ?? 0,
    criteria: r.criteria ?? {},
    comment: r.moderated === 'none' && r.comment ? r.comment : null,
    moderated: r.moderated,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * `GET /api/admin/ratings?filter=new|commented&cursor=&limit=` (модератор+): не модеровані
 * оцінки (без відмов), новіші першими; `commented` — лише з текстом. Персонал бачить ніки обох
 * сторін, але оцінки про самого переглядача в черзі не показуються — інакше оцінюваний
 * дізнався б, хто його оцінив.
 */
export async function listRatings(
  deps: Pick<AppDeps, 'db'>,
  viewer: { userId: number; role: Role },
  query: unknown,
): Promise<AdminPageDto<AdminRatingDto>> {
  assertCan(viewer.role, 'ratings.moderate');
  const { filter, cursor, limit } = adminRatingsQuerySchema.parse(query);
  const rows = await ratingsQuery(deps.db)
    .where(
      and(
        eq(ratings.declined, false),
        eq(ratings.moderated, 'none'),
        ne(ratings.rateeId, viewer.userId),
        filter === 'commented'
          ? and(isNotNull(ratings.comment), ne(ratings.comment, ''))
          : undefined,
        cursor !== undefined ? lt(ratings.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(ratings.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: page.map(toDto),
    nextCursor: rows.length > limit ? page[page.length - 1]!.r.id : null,
  };
}

type Action = 'hide-text' | 'cancel';

/**
 * Модерація оцінки (модератор+, роль — з БД). Відмова чи невідома → 404; оцінка про себе чи
 * власна → 403 `MODERATION_FORBIDDEN`; автор оцінки з рівною/вищою роллю → 403. `hide-text`:
 * лише неприхований непорожній текст; `cancel`: ще не анульована (прихований текст — можна
 * анулювати), інакше 409 `RATING_ALREADY_MODERATED`.
 *
 * `cancel` у транзакції дії перепубліковує зріз (`republish`): одразу, без нових оцінок, < 5
 * одиниць → зріз ховається. Ні автор, ні оцінюваний не сповіщаються; журнал — з причиною
 * (адмін+ бачать у журналі й прихований текст).
 */
async function moderateRating(
  deps: Pick<AppDeps, 'db'>,
  actorId: number,
  ratingId: number,
  body: unknown,
  action: Action,
): Promise<AdminRatingDto> {
  const { reason } = ratingModerationInputSchema.parse(body);
  return deps.db.transaction(async (tx) => {
    const role = await actorRole(tx, actorId);
    assertCan(role, 'ratings.moderate');
    // Звичайне читання — щоб узяти лок зрізу до лока оцінки (порядок як у `submitRating`).
    const [peek] = await tx
      .select({ rateeId: ratings.rateeId, role: ratings.role })
      .from(ratings)
      .where(eq(ratings.id, ratingId));
    if (!peek) throw new AppError(404, 'NOT_FOUND');
    if (action === 'cancel') await lockPublished(tx, peek.rateeId, peek.role);
    const [r] = await tx.select().from(ratings).where(eq(ratings.id, ratingId)).for('update');
    if (!r || r.declined) throw new AppError(404, 'NOT_FOUND');
    if (r.raterId === actorId || r.rateeId === actorId) {
      throw new AppError(403, 'MODERATION_FORBIDDEN');
    }
    const [rater] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, r.raterId));
    assertCanActOn(role, rater?.role ?? 'user');

    const hasText = !!r.comment;
    if (action === 'hide-text' ? r.moderated !== 'none' || !hasText : r.moderated === 'cancelled') {
      throw new AppError(409, 'RATING_ALREADY_MODERATED');
    }
    await tx
      .update(ratings)
      .set({
        moderated: action === 'cancel' ? 'cancelled' : 'text_hidden',
        moderatedBy: actorId,
        moderatedAt: new Date(),
      })
      .where(eq(ratings.id, ratingId));
    await writeLog(tx, {
      actorId,
      action: action === 'cancel' ? 'rating.cancel' : 'rating.hide_text',
      targetType: 'rating',
      targetId: ratingId,
      reason,
      // Текст оцінки — лише в журналі (адмін+): з черги й картки він зникає.
      meta: { role: r.role, kind: r.kind, ...(hasText ? { comment: r.comment } : {}) },
    });
    if (action === 'cancel') await republish(tx, r.rateeId, r.role);
    const [fresh] = await ratingsQuery(tx).where(eq(ratings.id, ratingId));
    return toDto(fresh!);
  });
}

/** `POST /api/admin/ratings/:id/hide-text {reason}`. */
export function hideRatingText(
  deps: Pick<AppDeps, 'db'>,
  actorId: number,
  ratingId: number,
  body: unknown,
): Promise<AdminRatingDto> {
  return moderateRating(deps, actorId, ratingId, body, 'hide-text');
}

/** `POST /api/admin/ratings/:id/cancel {reason}`. */
export function cancelRating(
  deps: Pick<AppDeps, 'db'>,
  actorId: number,
  ratingId: number,
  body: unknown,
): Promise<AdminRatingDto> {
  return moderateRating(deps, actorId, ratingId, body, 'cancel');
}
