import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { entityViewsInputSchema, type EntityViewType, type SeenState } from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import type { Tx } from '../applications/applications.rules.js';
import { entityViews, gameApplications, gameSessions, games } from '../db/schema/index.js';

type Exec = Db | Tx;

/** Таблиця сутності та її `updated_at` для кожного типу. */
const SOURCES = {
  game: { table: games, id: games.id, updatedAt: games.updatedAt },
  application: {
    table: gameApplications,
    id: gameApplications.id,
    updatedAt: gameApplications.updatedAt,
  },
  session: { table: gameSessions, id: gameSessions.id, updatedAt: gameSessions.updatedAt },
} as const;

/**
 * Позначає переглянутими сутності, що задовольняють `where` (тільки існуючі — `INSERT …
 * SELECT`). За замовчуванням `viewed_at = GREATEST(now, updated_at)`: власна зміна, щойно
 * записана, не стане «оновленням» навіть за розбіжності годинників. `at` — рівно цей час
 * (версія, яку глядач щойно отримав; новіша зміна лишиться «оновленням»). Повторний
 * перегляд не зсуває час назад.
 */
async function markWhere(
  exec: Exec,
  userId: number,
  type: EntityViewType,
  where: SQL | undefined,
  now: Date,
  at?: Date,
): Promise<void> {
  const src = SOURCES[type];
  const viewedAt = at
    ? sql`CAST(${at} AS DATETIME(3))`
    : sql`GREATEST(CAST(${now} AS DATETIME(3)), ${src.updatedAt})`;
  const rows = exec
    .select({
      userId: sql<number>`${userId}`.as('user_id'),
      entityType: sql<EntityViewType>`${type}`.as('entity_type'),
      entityId: sql<number>`${src.id}`.as('entity_id'),
      viewedAt: sql<Date>`${viewedAt}`.as('viewed_at'),
    })
    .from(src.table)
    .where(where);
  await exec.execute(sql`
    INSERT INTO ${entityViews} (user_id, entity_type, entity_id, viewed_at)
    SELECT * FROM (${rows}) AS v
    ON DUPLICATE KEY UPDATE viewed_at = GREATEST(${entityViews.viewedAt}, v.viewed_at)`);
}

/**
 * Позначає сутності `ids` переглянутими користувачем (без перевірки видимості). `at` — див.
 * `markWhere`.
 */
export async function markViewed(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  type: EntityViewType,
  ids: number[],
  at?: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await markWhere(deps.db, userId, type, inArray(SOURCES[type].id, ids), new Date(), at);
}

/**
 * Власна зміна користувача (після коміту): сутність для нього переглянута, тож його ж дія не
 * стає «оновленням». Найкраща спроба — збій лише логуємо (дію вже закомічено).
 */
export async function markOwnChange(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  type: EntityViewType,
  ids: number[],
): Promise<void> {
  try {
    await markViewed(deps, userId, type, ids);
  } catch (err) {
    console.error('[views] markOwnChange failed', err);
  }
}

/**
 * Усі сесії гри — переглянуті майстром (після його дій, що створюють/змінюють сесії
 * пачкою: публікація, нове правило). Найкраща спроба, як `markOwnChange`.
 */
export async function markGameSessionsViewed(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  gameId: number,
): Promise<void> {
  try {
    await markWhere(deps.db, userId, 'session', eq(gameSessions.gameId, gameId), new Date());
  } catch (err) {
    console.error('[views] markGameSessionsViewed failed', err);
  }
}

/** Стан перегляду для набору сутностей — одним запитом. */
export async function seenFor(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  type: EntityViewType,
  rows: { id: number; updatedAt: Date }[],
): Promise<Map<number, SeenState>> {
  const out = new Map<number, SeenState>();
  if (rows.length === 0) return out;
  const views = await deps.db
    .select({ id: entityViews.entityId, at: entityViews.viewedAt })
    .from(entityViews)
    .where(
      and(
        eq(entityViews.userId, userId),
        eq(entityViews.entityType, type),
        inArray(entityViews.entityId, [...new Set(rows.map((r) => r.id))]),
      ),
    );
  const at = new Map(views.map((v) => [v.id, v.at]));
  for (const r of rows) {
    const viewed = at.get(r.id);
    out.set(r.id, !viewed ? 'new' : r.updatedAt > viewed ? 'updated' : 'seen');
  }
  return out;
}

/**
 * Хто може позначити сутність переглянутою — ті самі, хто її бачить у DTO зі `seen`:
 * гра — майстер або опублікована; заявка — її автор або майстер гри; сесія — майстер або
 * активний учасник гри. Решта id мовчки відкидається (без розкриття існування).
 */
function visibleTo(userId: number, type: EntityViewType): SQL {
  switch (type) {
    case 'game':
      return sql`(${games.gmUserId} = ${userId} OR (${games.status} <> 'draft' AND ${games.publishedAt} IS NOT NULL))`;
    case 'application':
      return sql`(${gameApplications.userId} = ${userId} OR EXISTS (SELECT 1 FROM games g WHERE g.id = ${gameApplications.gameId} AND g.gm_user_id = ${userId}))`;
    case 'session':
      return sql`EXISTS (SELECT 1 FROM games g WHERE g.id = ${gameSessions.gameId} AND (g.gm_user_id = ${userId} OR EXISTS (SELECT 1 FROM game_members m WHERE m.game_id = g.id AND m.user_id = ${userId} AND m.left_at IS NULL)))`;
  }
}

/** `POST /api/me/views`. */
export async function markViewedByUser(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  body: unknown,
): Promise<void> {
  const { entityType, ids } = entityViewsInputSchema.parse(body);
  const where = and(
    inArray(SOURCES[entityType].id, [...new Set(ids)]),
    visibleTo(userId, entityType),
  );
  await markWhere(deps.db, userId, entityType, where, new Date());
}
