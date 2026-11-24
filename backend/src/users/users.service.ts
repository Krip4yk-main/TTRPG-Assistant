import { and, eq, sql } from 'drizzle-orm';
import {
  BIRTH_DATE_CHANGE_COOLDOWN_DAYS,
  canRegister,
  type CompleteProfileInput,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { evictUserSessionCache, revokeAllUserSessions } from '../auth/session.service.js';
import { isDuplicateKey, subjectHash } from '../auth/identity.service.js';
import { authIdentities, identityTombstones, sessions, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';

type Provider = typeof authIdentities.$inferSelect.provider;

export type MeDto = {
  id: number;
  nickname: string | null;
  avatarUrl: string | null;
  birthDate: string | null;
  role: typeof users.$inferSelect.role;
  status: typeof users.$inferSelect.status;
  timezone: string;
  locale: string;
  identities: { provider: Provider; displayName: string | null }[];
};

const DAY_MS = 86_400_000;
export type Clock = () => Date;
const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Ставить is_banned і скидає Redis-кеш сесій, тож бан діє з наступного ж запиту:
 * requireAuth бачить isBanned -> 403 ACCOUNT_BANNED і викликає revokeAllUserSessions
 * (далі 401). Рядки БД тут свідомо лишаються, щоб перший запит отримав зрозумілий 403.
 */
export async function banUser(deps: AppDeps, userId: number): Promise<void> {
  await deps.db.update(users).set({ isBanned: true }).where(eq(users.id, userId));
  await evictUserSessionCache(deps, userId);
  deps.realtime?.disconnectUser(userId);
}

export async function getMe(deps: Pick<AppDeps, 'db'>, userId: number): Promise<MeDto> {
  const { db } = deps;
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
  const identities = await db
    .select({ provider: authIdentities.provider, displayName: authIdentities.displayName })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId))
    .orderBy(authIdentities.id);
  return {
    id: u.id,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    birthDate: u.birthDate,
    role: u.role,
    status: u.status,
    timezone: u.timezone,
    locale: u.locale,
    identities,
  };
}

export type CompleteResult = { ok: true } | { ok: false; rejected: 'AGE_TOO_LOW' };

/**
 * Завершення профілю pending-користувача. Вік < 14: реєстрацію відхилено, pending-рядок
 * разом з ідентичностями та сесіями видаляється (tombstone не створюється).
 */
export async function completeProfile(
  deps: AppDeps,
  userId: number,
  input: CompleteProfileInput,
  now: Clock = () => new Date(),
): Promise<CompleteResult> {
  const { db } = deps;
  if (!canRegister(input.birthDate, utcDate(now()))) {
    const [del] = await db.transaction(async (tx) =>
      tx.delete(users).where(and(eq(users.id, userId), eq(users.status, 'pending'))),
    );
    if (del.affectedRows === 0) throw new AppError(400, 'VALIDATION', { reason: 'ALREADY_ACTIVE' });
    await revokeAllUserSessions(deps, userId);
    return { ok: false, rejected: 'AGE_TOO_LOW' };
  }
  try {
    const res = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(users)
        .set({
          nickname: input.nickname,
          birthDate: input.birthDate,
          status: 'active',
          ...(input.timezone ? { timezone: input.timezone } : {}),
        })
        .where(and(eq(users.id, userId), eq(users.status, 'pending')));
      return r;
    });
    if (res.affectedRows === 0) throw new AppError(400, 'VALIDATION', { reason: 'ALREADY_ACTIVE' });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'NICKNAME_TAKEN');
    throw err;
  }
  await evictUserSessionCache(deps, userId);
  await logEvent(db, { type: 'user.activated', userId });
  return { ok: true };
}

export async function changeBirthDate(
  deps: AppDeps,
  userId: number,
  birthDate: string,
  now: Clock = () => new Date(),
): Promise<void> {
  const { db } = deps;
  const current = now();
  const cutoff = new Date(current.getTime() - BIRTH_DATE_CHANGE_COOLDOWN_DAYS * DAY_MS);
  const changed = await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!u || u.status !== 'active') throw new AppError(401, 'UNAUTHENTICATED');
    if (u.birthDate === birthDate) return false;
    if (u.birthDateChangedAt && u.birthDateChangedAt > cutoff) {
      const availableAt = new Date(
        u.birthDateChangedAt.getTime() + BIRTH_DATE_CHANGE_COOLDOWN_DAYS * DAY_MS,
      );
      throw new AppError(409, 'BIRTH_DATE_COOLDOWN', { availableAt: availableAt.toISOString() });
    }
    if (!canRegister(birthDate, utcDate(current))) throw new AppError(422, 'AGE_TOO_LOW');
    await tx
      .update(users)
      .set({ birthDate, birthDateChangedAt: current })
      .where(eq(users.id, userId));
    return true;
  });
  if (!changed) return;
  await evictUserSessionCache(deps, userId);
  await logEvent(db, { type: 'user.birth_date_changed', userId });
}

export async function unlinkIdentity(
  deps: AppDeps,
  userId: number,
  provider: Provider,
): Promise<void> {
  const { db } = deps;
  await db.transaction(async (tx) => {
    // Лок рядка користувача серіалізує паралельні відв'язування.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const rows = await tx
      .select({ id: authIdentities.id, provider: authIdentities.provider })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    const target = rows.find((r) => r.provider === provider);
    if (!target) throw new AppError(404, 'NOT_FOUND');
    if (rows.length <= 1) throw new AppError(409, 'LAST_IDENTITY');
    await tx.delete(authIdentities).where(eq(authIdentities.id, target.id));
  });
  await logEvent(db, { type: 'identity.unlinked', userId, payload: { provider } });
}

export async function deleteAccount(deps: AppDeps, userId: number): Promise<void> {
  const { db, env } = deps;
  const now = new Date();
  await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
    if (u.role === 'owner') throw new AppError(409, 'OWNER_CANNOT_DELETE');
    const identities = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    for (const i of identities) {
      await tx
        .insert(identityTombstones)
        .values({
          provider: i.provider,
          subjectHash: subjectHash(i.provider, i.subject, env.IDENTITY_PEPPER),
          isBanned: u.isBanned,
        })
        .onDuplicateKeyUpdate({
          set: { isBanned: sql`GREATEST(${identityTombstones.isBanned}, ${u.isBanned ? 1 : 0})` },
        });
    }
    await tx.delete(authIdentities).where(eq(authIdentities.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx
      .update(users)
      .set({
        status: 'deleted',
        role: 'user',
        nickname: null,
        avatarUrl: null,
        birthDate: null,
        birthDateChangedAt: null,
        deletedAt: now,
      })
      .where(eq(users.id, userId));
  });
  await revokeAllUserSessions(deps, userId);
  await logEvent(db, { type: 'user.deleted', userId });
}
