import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { authIdentities, identityTombstones, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import type { Db } from '../db/client.js';
import { AppError } from '../http/errors.js';
import { generatePublicId, PUBLIC_ID_ATTEMPTS } from '../users/nickname.js';
import type { Provider, VerifiedIdentity } from './providers/provider.js';

type Deps = Pick<AppDeps, 'env' | 'db'>;

export const subjectHash = (provider: Provider, subject: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`${provider}:${subject}`).digest('hex');

export function isDuplicateKey(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; errno?: number };
    if (o.code === 'ER_DUP_ENTRY' || o.errno === 1062) return true;
  }
  return false;
}

/** Створює рядок користувача з унікальним publicId; колізія → повтор (до PUBLIC_ID_ATTEMPTS разів). */
export async function insertUserWithPublicId(
  db: Pick<Db, 'insert'>,
  avatarUrl: string | null,
): Promise<{ id: number }[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db
        .insert(users)
        .values({ status: 'pending', avatarUrl, publicId: generatePublicId() })
        .$returningId();
    } catch (err) {
      if (!isDuplicateKey(err) || attempt >= PUBLIC_ID_ATTEMPTS) throw err;
    }
  }
}

async function assertNotBanned({ env, db }: Deps, identity: VerifiedIdentity): Promise<void> {
  const [t] = await db
    .select({ isBanned: identityTombstones.isBanned })
    .from(identityTombstones)
    .where(
      and(
        eq(identityTombstones.provider, identity.provider),
        eq(
          identityTombstones.subjectHash,
          subjectHash(identity.provider, identity.subject, env.IDENTITY_PEPPER),
        ),
      ),
    );
  if (t?.isBanned) throw new AppError(403, 'IDENTITY_BANNED');
}

async function findOwner(db: Deps['db'], identity: VerifiedIdentity): Promise<number | null> {
  const [row] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.subject, identity.subject),
      ),
    );
  return row?.userId ?? null;
}

export async function resolveLogin(
  deps: Deps,
  identity: VerifiedIdentity,
): Promise<{ userId: number; isNew: boolean }> {
  const { db } = deps;
  const existing = await findOwner(db, identity);
  if (existing !== null) return { userId: existing, isNew: false };
  await assertNotBanned(deps, identity);

  let userId: number;
  try {
    userId = await db.transaction(async (tx) => {
      const [u] = await insertUserWithPublicId(tx, identity.avatarUrl ?? null);
      await tx.insert(authIdentities).values({
        userId: u!.id,
        provider: identity.provider,
        subject: identity.subject,
        displayName: identity.displayName ?? null,
      });
      return u!.id;
    });
  } catch (err) {
    // Гонка двох перших входів: наша транзакція відкотилась — читаємо переможця.
    if (!isDuplicateKey(err)) throw err;
    const winner = await findOwner(db, identity);
    if (winner === null) throw err;
    return { userId: winner, isNew: false };
  }
  await logEvent(db, {
    type: 'user.registered',
    userId,
    payload: { provider: identity.provider },
  });
  return { userId, isNew: true };
}

export async function linkIdentity(
  deps: Deps,
  userId: number,
  identity: VerifiedIdentity,
): Promise<void> {
  const { db } = deps;
  // Захист у глибину: не прив'язуємо до неіснуючого чи видаленого акаунта.
  const [target] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  if (!target || target.status === 'deleted') throw new AppError(404, 'NOT_FOUND');
  // true — ідентичність уже моя; кидає 409, якщо чужа.
  const alreadyMine = async (): Promise<boolean> => {
    const owner = await findOwner(db, identity);
    if (owner === userId) return true;
    if (owner !== null) throw new AppError(409, 'IDENTITY_TAKEN');
    return false;
  };
  if (await alreadyMine()) return;
  await assertNotBanned(deps, identity);
  const [sameProvider] = await db
    .select({ id: authIdentities.id })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, identity.provider)));
  if (sameProvider) throw new AppError(409, 'PROVIDER_ALREADY_LINKED');
  try {
    await db.transaction(async (tx) => {
      await tx.insert(authIdentities).values({
        userId,
        provider: identity.provider,
        subject: identity.subject,
        displayName: identity.displayName ?? null,
      });
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    if (await alreadyMine()) return;
    // Дублікат не за (provider, subject) — отже за (user_id, provider).
    throw new AppError(409, 'PROVIDER_ALREADY_LINKED');
  }
  await logEvent(db, {
    type: 'identity.linked',
    userId,
    payload: { provider: identity.provider },
  });
}
