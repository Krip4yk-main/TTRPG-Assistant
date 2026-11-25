import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  appealDecisionSchema,
  appealsQuerySchema,
  sanctionAppealInputSchema,
  type AdminPageDto,
  type AppealDto,
  type MySanctionDto,
  type SanctionAppealStatus,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { isDuplicateKey } from '../db/errors.js';
import { sanctionAppeals, sanctions, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { writeLog } from './log.js';
import { assertCan, can, ROLE_RANK, type Role } from './permissions.js';
import { activeAt } from './sanctions.enforce.js';
import {
  actorRole,
  isActive,
  liftSanctionTx,
  refsOf,
  runAfterCommit,
  type SanctionDeps,
} from './sanctions.service.js';

type DbLike = Db | Tx;

/** Право вирішувати апеляцію на санкцію типу `type`: бан — адмін+, решта — модератор+. */
function decideActionFor(type: string) {
  return type === 'global_ban' ? ('appeals.decide_ban' as const) : ('appeals.decide' as const);
}

/** Вставка апеляції; дубль (UNIQUE sanction_id) → 409 `APPEAL_EXISTS`. */
async function insertAppeal(
  tx: DbLike,
  sanctionId: number,
  userId: number,
  message: string,
): Promise<number> {
  try {
    const [res] = await tx
      .insert(sanctionAppeals)
      .values({ sanctionId, userId, message })
      .$returningId();
    return res!.id;
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'APPEAL_EXISTS');
    throw err;
  }
}

/**
 * `POST /api/me/sanctions/:id/appeal {message}`: апеляція на мою чинну санкцію — одна на
 * санкцію (повтор → 409 `APPEAL_EXISTS`). Чужа чи невідома → 404; знята/завершена → 409
 * `SANCTION_NOT_ACTIVE`. Повертає санкцію зі статусом апеляції.
 */
export async function appealMySanction(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  sanctionId: number,
  body: unknown,
  now: Date = new Date(),
): Promise<MySanctionDto> {
  const { message } = sanctionAppealInputSchema.parse(body);
  const [s] = await deps.db.select().from(sanctions).where(eq(sanctions.id, sanctionId));
  if (!s || s.userId !== userId) throw new AppError(404, 'NOT_FOUND');
  if (!isActive(s, now)) throw new AppError(409, 'SANCTION_NOT_ACTIVE');
  const id = await insertAppeal(deps.db, sanctionId, userId, message);
  await logEvent(deps.db, {
    type: 'appeal.created',
    userId,
    entityType: 'sanction_appeal',
    entityId: id,
    payload: { sanctionId },
  });
  return {
    id: s.id,
    type: s.type,
    reason: s.reason,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt ? s.endsAt.toISOString() : null,
    appealStatus: 'pending',
  };
}

// ---------- бан: апеляція за токеном ----------

/** Текст причини для бану, виставленого лише прапорцем (без санкції; `banUser`). */
export const FLAG_BAN_REASON = 'Бан без зазначеної причини.';

/** Найновіша чинна санкція-бан користувача (`null` — немає). */
export async function activeBanSanction(
  tx: DbLike,
  userId: number,
  now: Date = new Date(),
): Promise<number | null> {
  const [s] = await tx
    .select({ id: sanctions.id })
    .from(sanctions)
    .where(and(eq(sanctions.userId, userId), eq(sanctions.type, 'global_ban'), activeAt(now)))
    .orderBy(desc(sanctions.startsAt), desc(sanctions.id))
    .limit(1);
  return s?.id ?? null;
}

/** Системна безстрокова санкція-бан для бану лише прапорцем (журнал без актора). */
async function createFlagBanSanction(tx: Tx, userId: number, now: Date): Promise<number> {
  const [res] = await tx
    .insert(sanctions)
    .values({
      userId,
      type: 'global_ban',
      reason: FLAG_BAN_REASON,
      imposedBy: null,
      startsAt: now,
      endsAt: null,
    })
    .$returningId();
  await writeLog(tx, {
    actorId: null,
    action: 'sanction.impose',
    targetType: 'user',
    targetId: userId,
    reason: FLAG_BAN_REASON,
    meta: { sanctionId: res!.id, type: 'global_ban', duration: 'permanent', flagOnly: true },
  });
  return res!.id;
}

/** Статус апеляції на чинний бан користувача (екран бану: `details.appealStatus`). */
export async function banAppealStatus(
  db: DbLike,
  userId: number,
): Promise<SanctionAppealStatus | null> {
  const sanctionId = await activeBanSanction(db, userId);
  if (sanctionId === null) return null;
  const [a] = await db
    .select({ status: sanctionAppeals.status })
    .from(sanctionAppeals)
    .where(eq(sanctionAppeals.sanctionId, sanctionId));
  return a?.status ?? null;
}

/**
 * Апеляція забаненого (`POST /api/appeals` за токеном) — на чинну санкцію-бан, у
 * `sanction_appeals`. Рядок користувача під X-локом (паралельні апеляції/бан/зняття
 * серіалізуються), `is_banned` — з нього: уже не забанений → 403 `FORBIDDEN`.
 * - Є чинна санкція-бан → апеляція на найновішу.
 * - Немає жодної незнятої санкції-бану → бан лише прапорцем (`banUser`, прямий SQL): системна
 *   санкція, апеляція на неї.
 * - Є лише прострочені незняті (задача строків ще не дійшла) → знімаються тут же (як задача:
 *   розбан, сповіщення) і 409 `SANCTION_NOT_ACTIVE` — оскаржувати нічого.
 */
export async function createBanAppeal(
  deps: SanctionDeps,
  userId: number,
  message: string,
): Promise<{ id: number; sanctionId: number }> {
  const now = new Date();
  const r = await deps.db.transaction(async (tx) => {
    const [u] = await tx
      .select({ isBanned: users.isBanned, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
    if (!u.isBanned) throw new AppError(403, 'FORBIDDEN');
    const open = await tx
      .select()
      .from(sanctions)
      .where(
        and(
          eq(sanctions.userId, userId),
          eq(sanctions.type, 'global_ban'),
          isNull(sanctions.liftedAt),
        ),
      )
      .orderBy(desc(sanctions.startsAt), desc(sanctions.id))
      .for('update');
    const active = open.find((s) => isActive(s, now));
    if (active || open.length === 0) {
      const sanctionId = active?.id ?? (await createFlagBanSanction(tx, userId, now));
      const id = await insertAppeal(tx, sanctionId, userId, message);
      return { created: { id, sanctionId } } as const;
    }
    const after: (() => Promise<void>)[] = [];
    for (const s of open) {
      const lifted = await liftSanctionTx(deps, tx, null, s.id, { now, expired: true });
      if (lifted) after.push(lifted.afterCommit);
    }
    return { expired: after } as const;
  });
  if ('created' in r && r.created) return r.created;
  for (const fn of r.expired) await fn();
  throw new AppError(409, 'SANCTION_NOT_ACTIVE');
}

// ---------- черга персоналу ----------

/** Автор апеляції (його роль — у фільтрі видимості). */
const appealUser = alias(users, 'appeal_user');

/**
 * Які апеляції бачить роль: на санкції, які вона могла б вирішити (бан — адмін+), і лише людей
 * з нижчою роллю (як `assertCanActOn`).
 */
function visibleWhere(viewer: Role): SQL {
  const lower = (Object.keys(ROLE_RANK) as Role[]).filter((r) => ROLE_RANK[r] < ROLE_RANK[viewer]);
  if (lower.length === 0) return sql`FALSE`;
  return and(
    inArray(appealUser.role, lower),
    can(viewer, 'appeals.decide_ban') ? undefined : sql`${sanctions.type} <> 'global_ban'`,
  )!;
}

function appealsQuery(db: DbLike) {
  return db
    .select({ a: sanctionAppeals, s: sanctions })
    .from(sanctionAppeals)
    .innerJoin(sanctions, eq(sanctions.id, sanctionAppeals.sanctionId))
    .innerJoin(appealUser, eq(appealUser.id, sanctionAppeals.userId));
}

type AppealRow = Awaited<ReturnType<ReturnType<typeof appealsQuery>['execute']>>[number];

async function toAppealDtos(db: DbLike, rows: AppealRow[]): Promise<AppealDto[]> {
  const refs = await refsOf(
    db,
    rows.flatMap((r) => [r.a.userId, r.a.decidedBy]),
  );
  return rows.map(({ a, s }) => ({
    id: a.id,
    sanctionId: s.id,
    sanctionType: s.type,
    sanctionReason: s.reason,
    sanctionEndsAt: s.endsAt ? s.endsAt.toISOString() : null,
    user: refs.get(a.userId)!,
    message: a.message,
    status: a.status,
    decidedBy: a.decidedBy === null ? null : (refs.get(a.decidedBy) ?? null),
    decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
    decisionNote: a.decisionNote,
    createdAt: a.createdAt.toISOString(),
  }));
}

/** `GET /api/admin/appeals?status=&cursor=&limit=` — новіші першими, лише видимі ролі. */
export async function listAppeals(
  deps: Pick<AppDeps, 'db'>,
  viewer: { userId: number; role: Role },
  query: unknown,
): Promise<AdminPageDto<AppealDto>> {
  assertCan(viewer.role, 'appeals.decide');
  const { status, cursor, limit } = appealsQuerySchema.parse(query);
  const rows = await appealsQuery(deps.db)
    .where(
      and(
        visibleWhere(viewer.role),
        status ? eq(sanctionAppeals.status, status) : undefined,
        cursor !== undefined ? lt(sanctionAppeals.id, cursor) : undefined,
      ),
    )
    .orderBy(desc(sanctionAppeals.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    items: await toAppealDtos(deps.db, page),
    nextCursor: rows.length > limit ? page[page.length - 1]!.a.id : null,
  };
}

/**
 * `POST /api/admin/appeals/:id/decide {accept, note?}`. Права — за типом санкції (бан — адмін+)
 * і рангом (`assertCanActOn`), роль діяча — з БД. Уже вирішена → 409 `APPEAL_DECIDED`. Прийнята
 * й санкція ще чинна → `liftSanctionTx` (журнал `sanction.lift`, бан — розбан). Журнал
 * `appeal.accept` / `appeal.reject`; автору — `appeal.decided` (тип, рішення, примітка), зокрема
 * забаненому (Telegram; на екрані бану — `details.appealStatus`).
 */
export async function decideAppeal(
  deps: SanctionDeps,
  actorId: number,
  appealId: number,
  body: unknown,
): Promise<AppealDto> {
  const { accept, note } = appealDecisionSchema.parse(body);
  const result = await deps.db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(sanctionAppeals)
      .where(eq(sanctionAppeals.id, appealId))
      .for('update');
    if (!a) throw new AppError(404, 'NOT_FOUND');
    // Порядок як у зняття: користувач → санкція (обидва X). Рішення — за заблокованим рядком
    // санкції: паралельне зняття чи задача строків не змусять `liftSanctionTx` упасти з 409.
    const [target] = await tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, a.userId))
      .for('update');
    const [s] = await tx
      .select()
      .from(sanctions)
      .where(eq(sanctions.id, a.sanctionId))
      .for('update');
    if (!s || !target) throw new AppError(404, 'NOT_FOUND');
    const role = await actorRole(tx, actorId);
    // Невидима для ролі апеляція — як відсутня (не розкриваємо існування).
    if (!can(role, decideActionFor(s.type)) || ROLE_RANK[target.role] >= ROLE_RANK[role]) {
      if (!can(role, 'appeals.decide')) throw new AppError(403, 'MODERATION_FORBIDDEN');
      throw new AppError(404, 'NOT_FOUND');
    }
    if (a.status !== 'pending') throw new AppError(409, 'APPEAL_DECIDED');

    let liftAfter: (() => Promise<void>) | null = null;
    const now = new Date();
    if (accept && isActive(s, now)) {
      const lifted = await liftSanctionTx(deps, tx, actorId, s.id, {
        note: note ?? null,
        now,
        notify: false,
      });
      liftAfter = lifted?.afterCommit ?? null;
    }
    await tx
      .update(sanctionAppeals)
      .set({
        status: accept ? 'accepted' : 'rejected',
        decidedBy: actorId,
        decidedAt: now,
        decisionNote: note ?? null,
      })
      .where(eq(sanctionAppeals.id, appealId));
    await writeLog(tx, {
      actorId,
      action: accept ? 'appeal.accept' : 'appeal.reject',
      targetType: 'appeal',
      targetId: appealId,
      reason: note ?? null,
      meta: { sanctionId: s.id, type: s.type, userId: a.userId },
    });
    let row: NotificationRow | null = null;
    if (target.status === 'active') {
      row = await createNotification(deps, tx, {
        userId: a.userId,
        type: 'appeal.decided',
        category: 'moderation',
        params: { sanctionType: s.type, accepted: accept, ...(note ? { reason: note } : {}) },
        entityType: 'sanction',
        entityId: s.id,
      });
    }
    const [fresh] = await appealsQuery(tx).where(eq(sanctionAppeals.id, appealId));
    const [dto] = await toAppealDtos(tx, [fresh!]);
    return { dto: dto!, row, liftAfter };
  });
  await runAfterCommit('appeal', async () => {
    if (result.liftAfter) await result.liftAfter();
    if (result.row) emitNotificationsNew(deps, [result.row]);
  });
  return result.dto;
}
