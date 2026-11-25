import { and, eq, gt, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { SanctionActiveDetails, SanctionType } from '@nri/shared';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { sanctions } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';

type DbLike = Db | Tx;

/**
 * Умова «санкція чинна в момент `now`»: не знята, уже почалась і ще не скінчилась. Кінець
 * виключний: обмеження діє до останньої мілісекунди перед `ends_at`.
 */
export function activeAt(now: Date): SQL {
  return and(
    isNull(sanctions.liftedAt),
    lte(sanctions.startsAt, now),
    or(isNull(sanctions.endsAt), gt(sanctions.endsAt, now)),
  )!;
}

/** Чинні санкції користувача: тип → найпізніший кінець (`null` — назавжди). */
export async function activeSanctionEnds(
  q: DbLike,
  userId: number,
  now: Date = new Date(),
): Promise<Map<SanctionType, Date | null>> {
  const rows = await q
    .select({ type: sanctions.type, endsAt: sanctions.endsAt })
    .from(sanctions)
    .where(and(eq(sanctions.userId, userId), activeAt(now)));
  const out = new Map<SanctionType, Date | null>();
  for (const r of rows) {
    if (!out.has(r.type)) {
      out.set(r.type, r.endsAt);
      continue;
    }
    const prev = out.get(r.type)!;
    if (prev === null || r.endsAt === null) out.set(r.type, null);
    else if (r.endsAt > prev) out.set(r.type, r.endsAt);
  }
  return out;
}

/** Типи чинних санкцій користувача в момент `now`. */
export async function activeSanctions(
  q: DbLike,
  userId: number,
  now: Date = new Date(),
): Promise<Set<SanctionType>> {
  return new Set((await activeSanctionEnds(q, userId, now)).keys());
}

/** 409 `SANCTION_ACTIVE` з `details {type, endsAt}` — для обмеження, що заборонило дію. */
export function sanctionActiveError(type: SanctionType, endsAt: Date | null): AppError {
  const details: SanctionActiveDetails = { type, endsAt: endsAt ? endsAt.toISOString() : null };
  return new AppError(409, 'SANCTION_ACTIVE', details);
}

/** Кидає `SANCTION_ACTIVE`, якщо санкція `type` чинна. */
export async function assertNoSanction(
  q: DbLike,
  userId: number,
  type: SanctionType,
  now: Date = new Date(),
): Promise<void> {
  const ends = await activeSanctionEnds(q, userId, now);
  if (ends.has(type)) throw sanctionActiveError(type, ends.get(type)!);
}

/** Чи гра платна (ціна > 0). */
export const isPaid = (priceUah: number | null | undefined): boolean => (priceUah ?? 0) > 0;
