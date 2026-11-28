import { createHmac } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { authIdentities, identityTombstones, notifications, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import type { Db } from '../db/client.js';
import type { Tx } from '../applications/applications.rules.js';
import { isDuplicateKey } from '../db/errors.js';
import { AppError } from '../http/errors.js';
import { generatePublicId, PUBLIC_ID_ATTEMPTS } from '../users/nickname.js';
import { recomputeAvatar } from '../users/avatar.js';
import type { Provider, VerifiedIdentity } from './providers/provider.js';

type Deps = Pick<AppDeps, 'env' | 'db'>;

export const subjectHash = (provider: Provider, subject: string, pepper: string): string =>
  createHmac('sha256', pepper).update(`${provider}:${subject}`).digest('hex');

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

/**
 * Надгробок ідентичності (відв'язування чи видалення акаунта) з посиланням на користувача:
 * бан користувача позначає всі його надгробки (`markUserTombstones`). Повтор для тієї ж
 * ідентичності: позначка бану не знімається (`GREATEST`), а банований надгробок лишається за
 * забаненим власником — інакше розбан іншого акаунта зняв би чужий бан.
 */
export async function upsertTombstone(
  tx: Db | Tx,
  pepper: string,
  userId: number,
  isBanned: boolean,
  identity: { provider: Provider; subject: string },
): Promise<void> {
  const banned = isBanned ? 1 : 0;
  await tx
    .insert(identityTombstones)
    .values({
      provider: identity.provider,
      subjectHash: subjectHash(identity.provider, identity.subject, pepper),
      userId,
      isBanned,
    })
    // Порядок присвоєнь важливий: MySQL обчислює їх зліва направо, тож `user_id` бачить
    // ще старе `is_banned`.
    .onDuplicateKeyUpdate({
      set: {
        userId: sql`IF(${identityTombstones.isBanned} = 1, ${identityTombstones.userId}, ${userId})`,
        isBanned: sql`GREATEST(${identityTombstones.isBanned}, ${banned})`,
      },
    });
}

/** Позначає (бан) чи знімає позначку (розбан) з усіх надгробків користувача. */
export async function markUserTombstones(
  tx: Db | Tx,
  userId: number,
  isBanned: boolean,
): Promise<void> {
  await tx
    .update(identityTombstones)
    .set({ isBanned })
    .where(eq(identityTombstones.userId, userId));
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
  return (await findIdentity(db, identity))?.userId ?? null;
}

async function findIdentity(
  db: Deps['db'],
  identity: VerifiedIdentity,
): Promise<{ id: number; userId: number; avatarUrl: string | null } | null> {
  const [row] = await db
    .select({
      id: authIdentities.id,
      userId: authIdentities.userId,
      avatarUrl: authIdentities.avatarUrl,
    })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, identity.provider),
        eq(authIdentities.subject, identity.subject),
      ),
    );
  return row ?? null;
}

/**
 * Оновлює аватар ідентичності значенням від провайдера (`null` — прибрано) й, якщо він змінився,
 * перераховує ефективний `users.avatar_url`.
 */
async function refreshIdentityAvatar(
  db: Deps['db'],
  row: { id: number; userId: number; avatarUrl: string | null },
  identity: VerifiedIdentity,
): Promise<void> {
  // `undefined` — аватар невідомий (напр. прив'язка через бота): збережений не чіпаємо.
  if (identity.avatarUrl === undefined) return;
  const next = identity.avatarUrl;
  if (next === row.avatarUrl) return;
  await db.transaction(async (tx) => {
    await tx.update(authIdentities).set({ avatarUrl: next }).where(eq(authIdentities.id, row.id));
    await recomputeAvatar(tx, row.userId);
  });
}

export async function resolveLogin(
  deps: Deps,
  identity: VerifiedIdentity,
): Promise<{ userId: number; isNew: boolean }> {
  const { db } = deps;
  const existing = await findIdentity(db, identity);
  if (existing !== null) {
    await refreshIdentityAvatar(db, existing, identity);
    return { userId: existing.userId, isNew: false };
  }
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
        avatarUrl: identity.avatarUrl ?? null,
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
  // true — ідентичність уже моя (аватар оновлюємо); кидає 409, якщо чужа.
  const alreadyMine = async (): Promise<boolean> => {
    const row = await findIdentity(db, identity);
    if (row?.userId === userId) {
      await refreshIdentityAvatar(db, row, identity);
      return true;
    }
    if (row) throw new AppError(409, 'IDENTITY_TAKEN');
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
        avatarUrl: identity.avatarUrl ?? null,
      });
      await recomputeAvatar(tx, userId);
      // Персонал прив'язав Telegram — нагадування «прив'яжіть Telegram» більше не актуальне.
      if (identity.provider === 'telegram') {
        await tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.type, 'staff.telegram_required'),
              isNull(notifications.readAt),
            ),
          );
      }
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
