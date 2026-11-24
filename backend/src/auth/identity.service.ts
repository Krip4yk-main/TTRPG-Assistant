import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { authIdentities, identityTombstones, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import type { Provider, VerifiedIdentity } from './providers/provider.js';

type Deps = Pick<AppDeps, 'env' | 'db'>;

export const subjectHash = (provider: Provider, subject: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`${provider}:${subject}`).digest('hex');

function isDuplicateKey(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; errno?: number };
    if (o.code === 'ER_DUP_ENTRY' || o.errno === 1062) return true;
  }
  return false;
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
      const [u] = await tx
        .insert(users)
        .values({ status: 'pending', avatarUrl: identity.avatarUrl ?? null })
        .$returningId();
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
    throw err;
  }
  await logEvent(db, {
    type: 'identity.linked',
    userId,
    payload: { provider: identity.provider },
  });
}
