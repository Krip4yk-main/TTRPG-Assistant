import { and, asc, eq, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { APPLICATION_EXPIRE_MS, APPLICATION_PENDING_REMINDER_MS } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { isTransientDbError } from '../db/errors.js';
import { gameApplications, games, users } from '../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { applicationsChanged } from '../realtime/game-rooms.js';
import type { Tx } from './applications.rules.js';

export const APPLICATIONS_HOUSEKEEPING_JOB = 'applications.housekeeping';
/** Раз на годину: строки в днях, точність до години достатня. */
export const APPLICATIONS_HOUSEKEEPING_EVERY_MS = 3_600_000;
/** Не більше стількох заявок кожного виду (нагадування / прострочення) за прогін. */
export const APPLICATIONS_HOUSEKEEPING_PER_RUN = 500;
const BATCH = 100;

type Deps = Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>;

interface Candidate {
  id: number;
  gameId: number;
  userId: number;
  gameTitle: string;
  gmUserId: number;
}

export interface HousekeepingResult {
  /** Скільки заявок позначено нагаданими (сповіщення — лише активному майстру). */
  reminded: number;
  /** Скільки заявок прострочено (сповіщення — лише активному гравцю). */
  expired: number;
}

/** Активний акаунт (сповіщення лише таким, як у диспетчері). */
async function isActive(tx: Tx, userId: number): Promise<boolean> {
  const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId));
  return u?.status === 'active';
}

async function actorOf(tx: Tx, userId: number) {
  const [u] = await tx
    .select({ publicId: users.publicId, nickname: users.nickname, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  return u && u.status !== 'deleted' ? { publicId: u.publicId, nickname: u.nickname } : null;
}

/**
 * Обходить `pending`-заявки, створені не пізніше `cutoff` (від найстаріших), пачками по
 * `BATCH`, не більше `max`. `handle` у власній транзакції робить умовний UPDATE (повтор чи
 * паралельний прогін його не повторять) і повертає сповіщення (`null` — без нього) або
 * `undefined`, якщо заявку вже змінив хтось інший. Тимчасова помилка БД — заявка лишається на
 * наступний прогін (помилка прокидається в кінці, задача повторить); постійна — `onPermanent`
 * позначає заявку без сповіщення, щоб вона не займала голову черги.
 */
async function sweep(
  deps: Deps,
  where: ReturnType<typeof and>,
  max: number,
  handle: (tx: Tx, c: Candidate) => Promise<NotificationRow | null | undefined>,
  onPermanent: (c: Candidate) => Promise<unknown>,
  label: string,
): Promise<{ done: Candidate[]; created: NotificationRow[]; failure: unknown }> {
  const { db } = deps;
  const done: Candidate[] = [];
  const created: NotificationRow[] = [];
  const skipped = new Set<number>();
  let failure: unknown;
  let handled = 0;
  while (handled < max) {
    const rows = await db
      .select({
        id: gameApplications.id,
        gameId: gameApplications.gameId,
        userId: gameApplications.userId,
        gameTitle: games.title,
        gmUserId: games.gmUserId,
      })
      .from(gameApplications)
      .innerJoin(games, eq(games.id, gameApplications.gameId))
      .where(and(where, skipped.size ? notInArray(gameApplications.id, [...skipped]) : undefined))
      .orderBy(asc(gameApplications.createdAt), asc(gameApplications.id))
      .limit(Math.min(BATCH, max - handled));
    for (const c of rows) {
      handled++;
      try {
        const n = await db.transaction((tx) => handle(tx, c));
        if (n === undefined) continue;
        done.push(c);
        if (n) created.push(n);
      } catch (err) {
        console.error(`applications housekeeping (${label}): application ${c.id} failed`, err);
        skipped.add(c.id);
        if (isTransientDbError(err)) failure ??= err;
        else
          await onPermanent(c).catch((e: unknown) =>
            console.error(`applications housekeeping (${label}): mark ${c.id} failed`, e),
          );
      }
    }
    if (rows.length < BATCH) break;
  }
  return { done, created, failure };
}

/**
 * Строк заявок (`applications.housekeeping`, щогодини):
 * 1. `pending` старше 14 днів → `expired` (`decided_at` = зараз): місце не займає (рахуються
 *    лише `pending` і учасники), майстер її більше не затвердить (409), гравець може подати
 *    нову одразу; гравцю — `application.expired`.
 * 2. `pending` старше 3 днів → одне нагадування майстру `application.pending_reminder`
 *    (`reminded_at` ставиться в тій самій транзакції умовним UPDATE — рівно раз на заявку).
 * Спершу прострочення, тож заявці старшій за 14 днів нагадування вже не йде. Сповіщення — лише
 * активним акаунтам (неактивним — позначка без сповіщення). Повертає, скільки заявок оброблено.
 */
export async function runApplicationsHousekeeping(
  deps: Deps,
  now: Date,
  maxPerRun = APPLICATIONS_HOUSEKEEPING_PER_RUN,
): Promise<HousekeepingResult> {
  const { db } = deps;
  const expireCutoff = new Date(now.getTime() - APPLICATION_EXPIRE_MS);
  const remindCutoff = new Date(now.getTime() - APPLICATION_PENDING_REMINDER_MS);

  const expirable = (cutoff: Date) =>
    and(eq(gameApplications.status, 'pending'), lte(gameApplications.createdAt, cutoff));
  const expireUpdate = (q: Tx | typeof db, id: number) =>
    q
      .update(gameApplications)
      .set({ status: 'expired', decidedAt: now })
      .where(and(eq(gameApplications.id, id), expirable(expireCutoff)));

  const expired = await sweep(
    deps,
    expirable(expireCutoff),
    maxPerRun,
    async (tx, c) => {
      const [res] = await expireUpdate(tx, c.id);
      if (res.affectedRows === 0) return undefined;
      if (!(await isActive(tx, c.userId))) return null;
      return createNotification(deps, tx, {
        userId: c.userId,
        type: 'application.expired',
        category: 'applications',
        params: { gameId: c.gameId, gameTitle: c.gameTitle, applicationId: c.id },
        entityType: 'application',
        entityId: c.id,
      });
    },
    (c) => expireUpdate(db, c.id),
    'expire',
  );

  const remindable = and(
    eq(gameApplications.status, 'pending'),
    lte(gameApplications.createdAt, remindCutoff),
    isNull(gameApplications.remindedAt),
  );
  // Позначка нагадування — не зміна заявки для її сторін (`updated_at` лишається).
  const remindUpdate = (q: Tx | typeof db, id: number) =>
    q
      .update(gameApplications)
      .set({ remindedAt: now, updatedAt: sql`${gameApplications.updatedAt}` })
      .where(and(eq(gameApplications.id, id), remindable));

  const reminded = await sweep(
    deps,
    remindable,
    maxPerRun,
    async (tx, c) => {
      const [res] = await remindUpdate(tx, c.id);
      if (res.affectedRows === 0) return undefined;
      if (!(await isActive(tx, c.gmUserId))) return null;
      return createNotification(deps, tx, {
        userId: c.gmUserId,
        type: 'application.pending_reminder',
        category: 'applications',
        params: {
          gameId: c.gameId,
          gameTitle: c.gameTitle,
          applicationId: c.id,
          actor: await actorOf(tx, c.userId),
        },
        entityType: 'application',
        entityId: c.id,
      });
    },
    (c) => remindUpdate(db, c.id),
    'remind',
  );

  emitNotificationsNew(deps, [...expired.created, ...reminded.created]);
  // Прострочені заявки зникають із «На розгляді» в обох сторін.
  for (const c of expired.done) applicationsChanged(deps, c.gameId, [c.userId, c.gmUserId]);
  const failure = expired.failure ?? reminded.failure;
  if (failure) throw failure;
  return { reminded: reminded.done.length, expired: expired.done.length };
}
