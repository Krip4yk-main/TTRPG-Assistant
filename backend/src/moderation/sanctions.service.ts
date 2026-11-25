import { eq, inArray } from 'drizzle-orm';
import {
  sanctionEndsAt,
  sanctionInputSchema,
  type SanctionDto,
  type SanctionType,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { sanctionAppeals, sanctions, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { writeLog } from './log.js';
import { assertCan, assertCanActOn, type Role } from './permissions.js';

type DbLike = Db | Tx;
/** `db` може бути транзакцією викликача (дія за скаргою — `complaints.service`). */
export type SanctionDeps = Pick<AppDeps, 'env'> &
  Partial<Pick<AppDeps, 'redis' | 'realtime'>> & {
    db: DbLike;
  };

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
    active: s.liftedAt === null && (s.endsAt === null || s.endsAt.getTime() > now.getTime()),
    appealStatus: appeal?.status ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Право накласти санкцію цього типу: глобальний бан — адмін+, решта — модератор+. */
export function actionFor(type: SanctionType) {
  return type === 'global_ban' ? ('sanctions.ban' as const) : ('sanctions.impose' as const);
}

/**
 * Накладає санкцію `input` (`sanctionInputSchema`) на користувача `userId` від імені `actorId`.
 * Перевіряє права (`global_ban` — адмін+) і ранг (`assertCanActOn`), пише санкцію й журнал
 * (`sanction.impose`). `complaintId` — скарга, за якою накладено.
 *
 * Мінімальна версія (Task 2): лише рядок санкції й журнал. Task 3 додає застосування
 * (`global_ban` → `is_banned`, каскад), сповіщення покараному; сигнатура стабільна.
 * Працює і з `deps.db` = транзакція викликача (тоді все в ній; власна — інакше).
 */
export async function imposeSanction(
  deps: SanctionDeps,
  actorId: number,
  userId: number,
  input: unknown,
  complaintId?: number,
): Promise<SanctionDto> {
  const parsed = sanctionInputSchema.parse(input);
  const run = async (tx: DbLike): Promise<SanctionDto> => {
    const [actor] = await tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, actorId))
      .for('update');
    if (!actor || actor.status !== 'active') throw new AppError(403, 'MODERATION_FORBIDDEN');
    assertCan(actor.role, actionFor(parsed.type));
    const [target] = await tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!target || target.status === 'pending') throw new AppError(404, 'NOT_FOUND');
    assertCanActOn(actor.role, target.role);

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
    await writeLog(tx, {
      actorId,
      action: 'sanction.impose',
      targetType: 'user',
      targetId: userId,
      reason: parsed.reason,
      meta: {
        sanctionId: res!.id,
        type: parsed.type,
        duration: parsed.duration,
        ...(complaintId !== undefined ? { complaintId } : {}),
      },
    });
    return sanctionDto(tx, res!.id, startsAt);
  };
  // Tx теж має `transaction` (savepoint) — але не відкриваємо вкладену без потреби.
  return isTx(deps.db) ? run(deps.db) : (deps.db as Db).transaction(run);
}

/** Транзакція drizzle (MySqlTransaction) має `rollback`; пул — ні. */
function isTx(db: DbLike): db is Tx {
  return typeof (db as Partial<Tx>).rollback === 'function';
}
