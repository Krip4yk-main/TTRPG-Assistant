import { and, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { RatingRole } from '@nri/shared';
import type { Db } from '../../db/client.js';
import {
  authIdentities,
  complaints,
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

/** `auth_identities.display_name` dev-ідентичності демо-користувача — позначка «це демо». */
export const DEMO_IDENTITY_MARKER = 'seed:demo';
/**
 * Подія-маніфест (`events.type`): список демо-ігор власника, бо самі ігри позначки не мають.
 * Пишеться з `dispatched_at` — диспетчер сповіщень її не бере.
 */
export const DEMO_MANIFEST_EVENT = 'demo.seeded';

export interface DemoManifest {
  version: 1;
  seed: number;
  scale: number;
  ownerId: number | null;
  ownerGameIds: number[];
}

export interface DemoFootprint {
  userIds: number[];
  /** Ігри демо-майстрів і демо-ігри власника (з маніфестів). */
  gameIds: number[];
  manifestIds: number[];
}

const CHUNK = 500;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/** Що з демо-даних зараз є в БД. */
export async function findDemo(db: Db): Promise<DemoFootprint> {
  const userIds = (
    await db
      .select({ id: authIdentities.userId })
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.provider, 'dev'),
          eq(authIdentities.displayName, DEMO_IDENTITY_MARKER),
        ),
      )
  ).map((r) => r.id);
  const manifests = await db
    .select({ id: events.id, payload: events.payload })
    .from(events)
    .where(eq(events.type, DEMO_MANIFEST_EVENT));
  const ownerGameIds = manifests.flatMap((m) => (m.payload as DemoManifest).ownerGameIds ?? []);
  const gmGames = userIds.length
    ? (await db.select({ id: games.id }).from(games).where(inArray(games.gmUserId, userIds))).map(
        (r) => r.id,
      )
    : [];
  const existingOwnerGames = ownerGameIds.length
    ? (await db.select({ id: games.id }).from(games).where(inArray(games.id, ownerGameIds))).map(
        (r) => r.id,
      )
    : [];
  return {
    userIds,
    gameIds: [...new Set([...gmGames, ...existingOwnerGames])],
    manifestIds: manifests.map((m) => m.id),
  };
}

export const hasDemo = (f: DemoFootprint): boolean =>
  f.userIds.length > 0 || f.gameIds.length > 0 || f.manifestIds.length > 0;

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
  const f = await findDemo(db);
  if (!hasDemo(f)) return f;
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

  await db.transaction(async (tx) => {
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
  });
  return f;
}
