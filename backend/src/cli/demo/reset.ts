import { and, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { RatingRole } from '@nri/shared';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../applications/applications.rules.js';
import {
  authIdentities,
  complaints,
  demoEntities,
  entityViews,
  events,
  gameApplications,
  games,
  gameSessions,
  moderationLog,
  notifications,
  ratings,
  sanctionAppeals,
  sanctions,
  telegramOutbox,
  users,
} from '../../db/schema/index.js';
import { rebuildPublished } from './ratings-check.js';

/** `auth_identities.display_name` dev-ідентичності демо-користувача (лише інформативно). */
export const DEMO_IDENTITY_MARKER = 'seed:demo';
/**
 * Подія-маніфест першої версії сидера (до таблиці `demo_entities`): читається лише для
 * прибирання старих демо-даних, нові запуски її не пишуть.
 */
export const DEMO_MANIFEST_EVENT = 'demo.seeded';

interface LegacyManifest {
  ownerId: number | null;
  ownerGameIds: number[];
}

export interface DemoFootprint {
  userIds: number[];
  /** Ігри демо-майстрів і демо-ігри власника. */
  gameIds: number[];
  /** Маніфести першої версії (видаляються разом із даними). */
  manifestIds: number[];
}

type Q = Db | Tx;

const CHUNK = 500;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/**
 * Що з демо-даних зараз є в БД. Джерело — реєстр `demo_entities` (пишеться в транзакції
 * сидера). Дані першої версії (без реєстру) розпізнаються за dev-ідентичністю з позначкою, чий
 * `subject` збігається з ніком (dev-вхід під ніком «seed:demo» такої пари не дає), і за
 * маніфестом власника — лише ігри, де майстер справді `ownerId`. Позначені користувачі без
 * жодного маніфесту → помилка: ігри власника тоді не знайти, а часткове прибирання гірше.
 */
export async function findDemo(q: Q): Promise<DemoFootprint> {
  const registry = await q
    .select({ type: demoEntities.entityType, id: demoEntities.entityId })
    .from(demoEntities);
  const regUsers = registry.filter((r) => r.type === 'user').map((r) => r.id);
  const regGames = registry.filter((r) => r.type === 'game').map((r) => r.id);

  // Нік і subject порівнюються в коді (точний збіг; колонки мають різні колації).
  const legacyUsers = (
    await q
      .select({
        id: authIdentities.userId,
        subject: authIdentities.subject,
        nickname: users.nickname,
      })
      .from(authIdentities)
      .innerJoin(users, eq(users.id, authIdentities.userId))
      .where(
        and(
          eq(authIdentities.provider, 'dev'),
          eq(authIdentities.displayName, DEMO_IDENTITY_MARKER),
        ),
      )
  )
    .filter((r) => r.nickname === r.subject && !regUsers.includes(r.id))
    .map((r) => r.id);
  const manifests = await q
    .select({ id: events.id, payload: events.payload })
    .from(events)
    .where(eq(events.type, DEMO_MANIFEST_EVENT));
  if (legacyUsers.length && manifests.length === 0) {
    throw new Error(
      `found ${legacyUsers.length} marked demo users without a demo registry or owner manifest; refusing a partial reset`,
    );
  }
  const legacyOwnerGames: number[] = [];
  for (const m of manifests) {
    const p = m.payload as LegacyManifest;
    if (!p?.ownerId || !Array.isArray(p.ownerGameIds) || p.ownerGameIds.length === 0) continue;
    for (const part of chunks(p.ownerGameIds)) {
      const rows = await q
        .select({ id: games.id })
        .from(games)
        .where(and(inArray(games.id, part), eq(games.gmUserId, p.ownerId)));
      legacyOwnerGames.push(...rows.map((r) => r.id));
    }
  }
  const userIds = [...new Set([...regUsers, ...legacyUsers])];
  const existingUsers = userIds.length
    ? (await q.select({ id: users.id }).from(users).where(inArray(users.id, userIds))).map(
        (r) => r.id,
      )
    : [];
  const gmGames = existingUsers.length
    ? (
        await q.select({ id: games.id }).from(games).where(inArray(games.gmUserId, existingUsers))
      ).map((r) => r.id)
    : [];
  const listed = [...regGames, ...legacyOwnerGames];
  const existingGames = listed.length
    ? (await q.select({ id: games.id }).from(games).where(inArray(games.id, listed))).map(
        (r) => r.id,
      )
    : [];
  return {
    userIds: existingUsers,
    gameIds: [...new Set([...gmGames, ...existingGames])],
    manifestIds: manifests.map((m) => m.id),
  };
}

export const hasDemo = (f: DemoFootprint): boolean =>
  f.userIds.length > 0 || f.gameIds.length > 0 || f.manifestIds.length > 0;

/** Реєстр без рядків (дані вже видалено вручну) теж прибирається. */
async function registrySize(q: Q): Promise<number> {
  const [row] = await q.select({ n: sql<number>`count(*)` }).from(demoEntities);
  return Number(row?.n ?? 0);
}

const ids = <T extends { id: number }>(rows: T[]) => rows.map((r) => r.id);
const inOrNone = (col: Parameters<typeof inArray>[0], xs: number[]): SQL =>
  xs.length ? inArray(col, xs) : sql`false`;

/**
 * Видаляє демо-дані у FK-безпечному порядку. Майже все звисає з користувачів і ігор через
 * `ON DELETE CASCADE`, тож вручну прибираються лише зв'язки без каскаду: скарги (FK цілей без
 * дій), журнал модерації, події, сповіщення/перегляди не-демо користувачів про демо-сутності,
 * черга Telegram (без FK). Не-демо користувачі не видаляються й не змінюються; їхні зрізи
 * рейтингу, куди входили демо-оцінки (напр. рейтинг майстра власника), перебудовуються з
 * оцінок, що лишились.
 */
export async function resetDemo(db: Db): Promise<DemoFootprint> {
  return db.transaction((tx) => resetDemoTx(tx));
}

/** `resetDemo` у транзакції викликача (сидер: прибирання й нове наповнення — одна транзакція). */
export async function resetDemoTx(db: Tx): Promise<DemoFootprint> {
  const f = await findDemo(db);
  if (!hasDemo(f)) {
    if (await registrySize(db)) await db.delete(demoEntities);
    return f;
  }
  const { userIds, gameIds } = f;

  const sessionIds = gameIds.length
    ? ids(
        await db
          .select({ id: gameSessions.id })
          .from(gameSessions)
          .where(inArray(gameSessions.gameId, gameIds)),
      )
    : [];
  const applicationIds = ids(
    await db
      .select({ id: gameApplications.id })
      .from(gameApplications)
      .where(
        or(inOrNone(gameApplications.gameId, gameIds), inOrNone(gameApplications.userId, userIds)),
      ),
  );
  const ratingRows = await db
    .select({ id: ratings.id, rateeId: ratings.rateeId, role: ratings.role })
    .from(ratings)
    .where(
      or(
        inOrNone(ratings.gameId, gameIds),
        inOrNone(ratings.raterId, userIds),
        inOrNone(ratings.rateeId, userIds),
      ),
    );
  const demoUsers = new Set(userIds);
  const rebuild = new Map<string, { userId: number; role: RatingRole }>();
  for (const r of ratingRows) {
    if (!demoUsers.has(r.rateeId))
      rebuild.set(`${r.rateeId}:${r.role}`, { userId: r.rateeId, role: r.role });
  }
  const complaintIds = ids(
    await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(
        or(
          inOrNone(complaints.reporterId, userIds),
          inOrNone(complaints.targetUserId, userIds),
          inOrNone(complaints.targetGameId, gameIds),
        ),
      ),
  );
  const sanctionIds = ids(
    await db
      .select({ id: sanctions.id })
      .from(sanctions)
      .where(inOrNone(sanctions.userId, userIds)),
  );
  const appealIds = ids(
    await db
      .select({ id: sanctionAppeals.id })
      .from(sanctionAppeals)
      .where(
        or(
          inOrNone(sanctionAppeals.userId, userIds),
          inOrNone(sanctionAppeals.sanctionId, sanctionIds),
        ),
      ),
  );

  {
    const tx = db;
    const logTargets: [string, number[]][] = [
      ['user', userIds],
      ['game', gameIds],
      ['complaint', complaintIds],
      ['sanction', sanctionIds],
      ['appeal', appealIds],
      ['rating', ids(ratingRows)],
    ];
    for (const [type, list] of logTargets) {
      for (const part of chunks(list)) {
        await tx
          .delete(moderationLog)
          .where(and(eq(moderationLog.targetType, type), inArray(moderationLog.targetId, part)));
      }
    }
    for (const part of chunks(complaintIds)) {
      await tx.delete(complaints).where(inArray(complaints.id, part));
    }
    // Сповіщення й перегляди НЕ-демо користувачів (власника) про демо-сутності.
    const entityTargets: [string, number[]][] = [
      ['game', gameIds],
      ['application', applicationIds],
      ['session', sessionIds],
    ];
    const others = userIds.length ? notInArray(notifications.userId, userIds) : undefined;
    for (const [type, list] of entityTargets) {
      for (const part of chunks(list)) {
        await tx
          .delete(notifications)
          .where(
            and(others, eq(notifications.entityType, type), inArray(notifications.entityId, part)),
          );
        await tx
          .delete(entityViews)
          .where(
            and(
              eq(entityViews.entityType, type as 'game' | 'application' | 'session'),
              inArray(entityViews.entityId, part),
            ),
          );
        await tx
          .delete(events)
          .where(and(eq(events.entityType, type), inArray(events.entityId, part)));
      }
    }
    for (const part of chunks(gameIds)) {
      await tx.delete(notifications).where(
        and(
          others,
          sql`json_unquote(json_extract(${notifications.payload}, '$.gameId')) in (${sql.join(
            part.map((id) => sql`${String(id)}`),
            sql`, `,
          )})`,
        ),
      );
    }
    for (const part of chunks(userIds)) {
      await tx.delete(events).where(inArray(events.userId, part));
      await tx.delete(telegramOutbox).where(inArray(telegramOutbox.userId, part));
    }
    // Ігри (сесії, заявки, членства, оцінки, нотатки — каскадом), потім користувачі.
    for (const part of chunks(gameIds)) await tx.delete(games).where(inArray(games.id, part));
    for (const part of chunks(userIds)) await tx.delete(users).where(inArray(users.id, part));
    if (f.manifestIds.length) await tx.delete(events).where(inArray(events.id, f.manifestIds));
    // Рядок зрізу є завжди: його створює `lockPublished` при кожній оцінці, зокрема відмові.
    for (const { userId, role } of rebuild.values()) await rebuildPublished(tx, userId, role);
    await tx.delete(demoEntities);
  }
  return f;
}
