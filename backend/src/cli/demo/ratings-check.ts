import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { RATING_BATCH_UNITS, RATING_MIN_UNITS, type RatingRole } from '@nri/shared';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../applications/applications.rules.js';
import { publishedRatings, ratings } from '../../db/schema/index.js';
import { computeRating } from '../../ratings/ratings.aggregate.js';

type DbLike = Db | Tx;

/** Оцінки, що входять у рейтинг (як `counted` у ratings.service). */
const countedRows = (db: DbLike, userId: number, role: RatingRole) =>
  db
    .select({
      id: ratings.id,
      raterId: ratings.raterId,
      gameId: ratings.gameId,
      overall: ratings.overall,
      criteria: ratings.criteria,
      createdAt: ratings.createdAt,
    })
    .from(ratings)
    .where(
      and(
        eq(ratings.rateeId, userId),
        eq(ratings.role, role),
        eq(ratings.declined, false),
        ne(ratings.moderated, 'cancelled'),
      ),
    )
    .orderBy(asc(ratings.id));

const scoredOf = <T extends { overall: number | null }>(rows: T[]) =>
  rows.filter((r) => r.overall !== null).map((r) => ({ ...r, overall: r.overall! }));

/**
 * Перебудова зрізу (людина, роль) з нуля: повторює `maybePublish` після кожної оцінки за
 * зростанням id (перша публікація — від 5 одиниць, далі — кожні 5 нових). Потрібна після
 * видалення демо-оцінок, що входили в зріз реального користувача (напр. власника). Анулювань
 * модерацією в демо немає, тож повтор історії точний; без жодної публікації рядок —
 * заготовка (`units` = 0).
 */
export async function rebuildPublished(tx: Tx, userId: number, role: RatingRole): Promise<void> {
  const rows = scoredOf(await countedRows(tx, userId, role));
  let published: { units: number; upTo: number; at: Date } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const units = computeRating(rows.slice(0, i + 1)).units;
    if (units < RATING_MIN_UNITS) continue;
    if (units - (published?.units ?? 0) < RATING_BATCH_UNITS) continue;
    published = { units, upTo: i + 1, at: rows[i]!.createdAt };
  }
  const where = and(eq(publishedRatings.userId, userId), eq(publishedRatings.role, role));
  if (!published) {
    await tx
      .update(publishedRatings)
      .set({
        overall: null,
        overallUnits: 0,
        criteria: null,
        units: 0,
        lastRatingId: null,
        publishedAt: null,
      })
      .where(where);
    return;
  }
  const slice = rows.slice(0, published.upTo);
  const c = computeRating(slice);
  await tx
    .update(publishedRatings)
    .set({
      overall: c.overall,
      overallUnits: c.overallUnits,
      criteria: c.criteria,
      units: c.units,
      lastRatingId: slice.reduce((m, r) => Math.max(m, r.id), 0),
      publishedAt: published.at,
    })
    .where(where);
}

export interface SnapshotIssue {
  userId: number;
  role: RatingRole;
  problem: string;
}

/**
 * Перевірка інваріантів зрізів (План 5) для заданих людей (або всіх): опублікований зріз =
 * агрегат оцінок з `id ≤ last_rating_id`, від 5 одиниць; неопубліковані нові одиниці — менше
 * 5 (інакше `maybePublish` уже мав опублікувати); без зрізу — загалом менше 5 одиниць.
 */
export async function checkRatingSnapshots(
  db: DbLike,
  userIds?: number[],
): Promise<SnapshotIssue[]> {
  const pairs = await db
    .selectDistinct({ userId: ratings.rateeId, role: ratings.role })
    .from(ratings)
    .where(userIds ? inArray(ratings.rateeId, userIds.length ? userIds : [0]) : undefined);
  const snaps = await db
    .select()
    .from(publishedRatings)
    .where(userIds ? inArray(publishedRatings.userId, userIds.length ? userIds : [0]) : undefined);
  const snapOf = new Map(snaps.map((s) => [`${s.userId}:${s.role}`, s]));
  const issues: SnapshotIssue[] = [];
  const keys = new Set([...pairs.map((p) => `${p.userId}:${p.role}`), ...snapOf.keys()]);
  for (const key of keys) {
    const [u, role] = key.split(':') as [string, RatingRole];
    const userId = Number(u);
    const rows = scoredOf(await countedRows(db, userId, role));
    const total = computeRating(rows).units;
    const snap = snapOf.get(key);
    const issue = (problem: string) => issues.push({ userId, role, problem });
    if (!snap || snap.lastRatingId === null) {
      if (total >= RATING_MIN_UNITS) issue(`no snapshot with ${total} units`);
      if (snap && (snap.units !== 0 || snap.overall !== null)) issue('placeholder has data');
      continue;
    }
    const c = computeRating(rows.filter((r) => r.id <= snap.lastRatingId!));
    if (c.units !== snap.units) issue(`units ${snap.units} != ${c.units}`);
    if (c.units < RATING_MIN_UNITS) issue(`published with ${c.units} units`);
    if (c.overall !== (snap.overall === null ? null : Number(snap.overall))) {
      issue(`overall ${snap.overall} != ${c.overall}`);
    }
    if (c.overallUnits !== snap.overallUnits) issue('overallUnits mismatch');
    if (JSON.stringify(sortKeys(c.criteria)) !== JSON.stringify(sortKeys(snap.criteria ?? {}))) {
      issue('criteria mismatch');
    }
    if (total - snap.units >= RATING_BATCH_UNITS) issue(`unpublished batch ${total - snap.units}`);
  }
  return issues;
}

const sortKeys = (o: object) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
