import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  sanctionEndsAt,
  sanctionInputSchema,
  sanctionLiftSchema,
  type MySanctionDto,
  type SanctionDto,
  type SanctionType,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { markUserTombstones } from '../auth/identity.service.js';
import { evictUserSessionCache, revokeAllUserSessions } from '../auth/session.service.js';
import type { Db } from '../db/client.js';
import { sanctionAppeals, sanctions, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import {
  leaveCandidates,
  lockLeaveGames,
  logLeaveCascade,
  pingLeaveCascade,
  runLeaveCascade,
  type LeaveCascadeResult,
} from '../users/leave-cascade.js';
import { writeLog } from './log.js';
import { assertCan, assertCanActOn, type Role } from './permissions.js';
import { activeAt } from './sanctions.enforce.js';

type DbLike = Db | Tx;

/** Залежності санкцій: `db` — пул (побічні ефекти після коміту пишуть події через нього). */
export type SanctionDeps = Pick<AppDeps, 'db' | 'env' | 'redis'> &
  Partial<Pick<AppDeps, 'realtime'>>;

/**
 * Результат дії в транзакції викликача: DTO і побічні ефекти, які викликач запускає лише
 * ПІСЛЯ свого коміту (пінги сповіщень, відкликання сесій, події каскаду). Відкат — і їх нема.
 */
export interface SanctionTxResult {
  dto: SanctionDto;
  afterCommit: () => Promise<void>;
}

export type UserRef = { publicId: string; nickname: string | null; role: Role };

async function refsOf(db: DbLike, ids: (number | null)[]): Promise<Map<number, UserRef>> {
  const list = [...new Set(ids.filter((x): x is number => x !== null))];
  if (list.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      publicId: users.publicId,
      nickname: users.nickname,
      role: users.role,
    })
    .from(users)
    .where(inArray(users.id, list));
  return new Map(
    rows.map((r) => [r.id, { publicId: r.publicId, nickname: r.nickname, role: r.role }]),
  );
}

/** Санкція для персоналу (`SanctionDto`). */
export async function sanctionDto(
  db: DbLike,
  id: number,
  now: Date = new Date(),
): Promise<SanctionDto> {
  const [s] = await db.select().from(sanctions).where(eq(sanctions.id, id));
  if (!s) throw new AppError(404, 'NOT_FOUND');
  const [appeal] = await db
    .select({ status: sanctionAppeals.status })
    .from(sanctionAppeals)
    .where(eq(sanctionAppeals.sanctionId, id));
  const refs = await refsOf(db, [s.userId, s.imposedBy, s.liftedBy]);
  const ref = (x: number | null) => (x === null ? null : (refs.get(x) ?? null));
  return {
    id: s.id,
    user: refs.get(s.userId)!,
    type: s.type,
    reason: s.reason,
    imposedBy: ref(s.imposedBy),
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt ? s.endsAt.toISOString() : null,
    liftedAt: s.liftedAt ? s.liftedAt.toISOString() : null,
    liftedBy: ref(s.liftedBy),
    complaintId: s.complaintId,
    active: isActive(s, now),
    appealStatus: appeal?.status ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function isActive(
  s: { liftedAt: Date | null; startsAt: Date; endsAt: Date | null },
  now: Date,
): boolean {
  return (
    s.liftedAt === null &&
    s.startsAt.getTime() <= now.getTime() &&
    (s.endsAt === null || s.endsAt.getTime() > now.getTime())
  );
}

/** Право накласти/зняти санкцію цього типу: глобальний бан — адмін+, решта — модератор+. */
export function actionFor(type: SanctionType) {
  return type === 'global_ban' ? ('sanctions.ban' as const) : ('sanctions.impose' as const);
}

/** Роль діяча (звичайне читання — лише для перевірки прав). Неактивний → 403. */
async function actorRole(tx: DbLike, actorId: number): Promise<Role> {
  const [actor] = await tx
    .select({ role: users.role, status: users.status, isBanned: users.isBanned })
    .from(users)
    .where(eq(users.id, actorId));
  if (!actor || actor.status !== 'active' || actor.isBanned) {
    throw new AppError(403, 'MODERATION_FORBIDDEN');
  }
  return actor.role;
}

/** Запускає побічні ефекти після коміту; помилка не скасовує вже зафіксовану дію. */
async function runAfterCommit(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[moderation] ${label}: after-commit effects failed`, err);
  }
}

// ---------- накладення ----------

/**
 * Накладає санкцію `input` (`sanctionInputSchema`) на `userId` від імені `actorId` у транзакції
 * викликача `tx`: права (`global_ban` — адмін+) і ранг (`assertCanActOn`), рядок санкції,
 * журнал (`sanction.impose`), сповіщення `sanction.imposed` покараному (тип, кінець, причина).
 *
 * `global_ban` додатково: `is_banned=1` (`ban_epoch+1`, якщо ще не забанений), позначка всіх
 * надгробків користувача, каскад як при видаленні акаунта (`banned_by_admin`): скасування
 * активних ігор майстра, відкликання заявок, вихід з ігор. Після коміту (`afterCommit`) —
 * відкликання всіх сесій, події каскаду (з них звичайні сповіщення гравцям) і пінги.
 *
 * Порядок блокувань (як у каскаді): ігри → рядок користувача → заявки/членства. `candidates` —
 * ігри для блокування, прочитані до транзакції (`leaveCandidates`); без них читаються тут.
 * Видалений акаунт можна лише забанити (позначити надгробки), менші санкції — 404.
 */
export async function imposeSanctionTx(
  deps: SanctionDeps,
  tx: Tx,
  actorId: number,
  userId: number,
  input: unknown,
  complaintId?: number,
  candidates?: number[],
): Promise<SanctionTxResult> {
  const parsed = sanctionInputSchema.parse(input);
  const isBan = parsed.type === 'global_ban';
  const role = await actorRole(tx, actorId);
  assertCan(role, actionFor(parsed.type));
  const active = isBan
    ? await lockLeaveGames(tx, userId, candidates ?? (await leaveCandidates(tx, userId)))
    : [];
  const [target] = await tx
    .select({
      role: users.role,
      status: users.status,
      isBanned: users.isBanned,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!target || target.status === 'pending') throw new AppError(404, 'NOT_FOUND');
  if (target.status === 'deleted' && !isBan) throw new AppError(404, 'NOT_FOUND');
  assertCanActOn(role, target.role);

  const startsAt = new Date();
  const endsAt = sanctionEndsAt(startsAt, parsed.duration);
  const [res] = await tx
    .insert(sanctions)
    .values({
      userId,
      type: parsed.type,
      reason: parsed.reason,
      imposedBy: actorId,
      startsAt,
      endsAt,
      complaintId: complaintId ?? null,
    })
    .$returningId();
  const sanctionId = res!.id;
  await writeLog(tx, {
    actorId,
    action: 'sanction.impose',
    targetType: 'user',
    targetId: userId,
    reason: parsed.reason,
    meta: {
      sanctionId,
      type: parsed.type,
      duration: parsed.duration,
      ...(complaintId !== undefined ? { complaintId } : {}),
    },
  });

  let cascade: LeaveCascadeResult | null = null;
  if (isBan) {
    await tx
      .update(users)
      .set({ isBanned: true, banEpoch: sql`${users.banEpoch} + 1` })
      .where(and(eq(users.id, userId), eq(users.isBanned, false)));
    await markUserTombstones(tx, userId, true);
    if (target.status === 'active') {
      cascade = await runLeaveCascade(tx, userId, active, startsAt, 'banned_by_admin');
    }
  }

  let row: NotificationRow | null = null;
  if (target.status === 'active') {
    row = await createNotification(deps, tx, {
      userId,
      type: 'sanction.imposed',
      category: 'moderation',
      params: {
        sanctionType: parsed.type,
        endsAt: endsAt ? endsAt.toISOString() : null,
        reason: parsed.reason,
      },
      entityType: 'sanction',
      entityId: sanctionId,
    });
  }
  const dto = await sanctionDto(tx, sanctionId, startsAt);
  const afterCommit = () =>
    runAfterCommit('impose', async () => {
      if (row) emitNotificationsNew(deps, [row]);
      if (!isBan) return;
      await revokeAllUserSessions(deps, userId);
      if (cascade) {
        await logLeaveCascade(deps.db, userId, cascade, 'banned_by_admin');
        await pingLeaveCascade(deps, userId, cascade);
      }
    });
  return { dto, afterCommit };
}

/** Накладення у власній транзакції (`imposeSanctionTx`); побічні ефекти — після коміту. */
export async function imposeSanction(
  deps: SanctionDeps,
  actorId: number,
  userId: number,
  input: unknown,
  complaintId?: number,
): Promise<SanctionDto> {
  const parsed = sanctionInputSchema.parse(input);
  // Кандидати для блокування — до транзакції (див. `leave-cascade.ts`).
  const candidates =
    parsed.type === 'global_ban' ? await leaveCandidates(deps.db, userId) : undefined;
  const r = await deps.db.transaction((tx) =>
    imposeSanctionTx(deps, tx, actorId, userId, parsed, complaintId, candidates),
  );
  await r.afterCommit();
  return r.dto;
}

// ---------- зняття ----------

export interface LiftOptions {
  note?: string | null;
  now?: Date;
  /** Строк минув (задача `moderation.expire`): `lifted_at` = `ends_at`, актор — система. */
  expired?: boolean;
}

/**
 * Знімає санкцію `sanctionId` у транзакції викликача. `actorId` = `null` — система (строк
 * минув). Для персоналу — ті самі права, що й на накладення (бан — адмін+), і ранг. Уже знята
 * чи завершена → 409 `SANCTION_NOT_ACTIVE` (для `expired` — без помилки: `null`).
 *
 * `global_ban`: якщо інших чинних банів немає — `is_banned=0` і зняття позначки з надгробків.
 * Скасоване під час бану не відновлюється. Сповіщення `sanction.lifted` (крім випадку, коли
 * людина лишається забаненою іншим баном).
 */
export async function liftSanctionTx(
  deps: SanctionDeps,
  tx: Tx,
  actorId: number | null,
  sanctionId: number,
  opts: LiftOptions = {},
): Promise<SanctionTxResult | null> {
  const now = opts.now ?? new Date();
  // Користувача санкції беремо звичайним читанням, щоб блокувати в порядку users → sanctions
  // (накладення бере `users` під X і вставляє санкцію).
  const [peek] = await tx
    .select({ userId: sanctions.userId })
    .from(sanctions)
    .where(eq(sanctions.id, sanctionId));
  if (!peek) throw new AppError(404, 'NOT_FOUND');
  const [target] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, peek.userId))
    .for('update');
  const [s] = await tx.select().from(sanctions).where(eq(sanctions.id, sanctionId)).for('update');
  if (!s || !target) throw new AppError(404, 'NOT_FOUND');
  if (actorId !== null) {
    const role = await actorRole(tx, actorId);
    assertCan(role, actionFor(s.type));
    assertCanActOn(role, target.role);
  }
  if (opts.expired) {
    if (s.liftedAt !== null || s.endsAt === null || s.endsAt.getTime() > now.getTime()) return null;
  } else if (!isActive(s, now)) {
    throw new AppError(409, 'SANCTION_NOT_ACTIVE');
  }
  const liftedAt = opts.expired ? s.endsAt! : now;
  await tx
    .update(sanctions)
    .set({ liftedAt, liftedBy: actorId })
    .where(eq(sanctions.id, sanctionId));
  await writeLog(tx, {
    actorId,
    action: opts.expired ? 'sanction.expire' : 'sanction.lift',
    targetType: 'user',
    targetId: s.userId,
    reason: opts.note ?? null,
    meta: { sanctionId, type: s.type },
  });

  let unbanned = false;
  let stillBanned = false;
  if (s.type === 'global_ban') {
    // Блокувальне читання: бачить і щойно закомічений новий бан (знімок тут застарів би).
    const [other] = await tx
      .select({ id: sanctions.id })
      .from(sanctions)
      .where(
        and(
          eq(sanctions.userId, s.userId),
          eq(sanctions.type, 'global_ban'),
          ne(sanctions.id, sanctionId),
          activeAt(now),
        ),
      )
      .limit(1)
      .for('share');
    if (other) {
      stillBanned = true;
    } else {
      await tx.update(users).set({ isBanned: false }).where(eq(users.id, s.userId));
      await markUserTombstones(tx, s.userId, false);
      unbanned = true;
    }
  }

  let row: NotificationRow | null = null;
  if (target.status === 'active' && !stillBanned) {
    row = await createNotification(deps, tx, {
      userId: s.userId,
      type: 'sanction.lifted',
      category: 'moderation',
      params: { sanctionType: s.type },
      entityType: 'sanction',
      entityId: sanctionId,
    });
  }
  const dto = await sanctionDto(tx, sanctionId, now);
  const afterCommit = () =>
    runAfterCommit('lift', async () => {
      if (row) emitNotificationsNew(deps, [row]);
      // Кеш сесій міг зберегти `isBanned` — скидаємо (самі сесії бан уже відкликав).
      if (unbanned) await evictUserSessionCache(deps, s.userId);
    });
  return { dto, afterCommit };
}

/** `POST /api/admin/sanctions/:id/lift {note?}`: дострокове зняття персоналом. */
export async function liftSanction(
  deps: SanctionDeps,
  actorId: number,
  sanctionId: number,
  body: unknown = {},
): Promise<SanctionDto> {
  const { note } = sanctionLiftSchema.parse(body ?? {});
  const r = await deps.db.transaction((tx) =>
    liftSanctionTx(deps, tx, actorId, sanctionId, { note: note ?? null }),
  );
  await r!.afterCommit();
  return r!.dto;
}

// ---------- мої санкції ----------

/** `GET /api/me/sanctions`: мої чинні санкції з причиною й кінцем (без того, хто наклав). */
export async function mySanctions(
  deps: Pick<AppDeps, 'db'>,
  userId: number,
  now: Date = new Date(),
): Promise<MySanctionDto[]> {
  const rows = await deps.db
    .select({
      id: sanctions.id,
      type: sanctions.type,
      reason: sanctions.reason,
      startsAt: sanctions.startsAt,
      endsAt: sanctions.endsAt,
      appealStatus: sanctionAppeals.status,
    })
    .from(sanctions)
    .leftJoin(sanctionAppeals, eq(sanctionAppeals.sanctionId, sanctions.id))
    .where(and(eq(sanctions.userId, userId), activeAt(now)))
    .orderBy(asc(sanctions.startsAt), asc(sanctions.id));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    reason: r.reason,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    appealStatus: r.appealStatus ?? null,
  }));
}

/** Користувач за `publicId` для дій персоналу (pending — як неіснуючий). */
export async function userIdByPublicId(db: DbLike, publicId: string): Promise<number> {
  const [u] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.publicId, publicId));
  if (!u || u.status === 'pending') throw new AppError(404, 'NOT_FOUND');
  return u.id;
}
