import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  BIRTH_DATE_CHANGE_COOLDOWN_DAYS,
  canRegister,
  localDate,
  type CompleteProfileInput,
  type MeDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  evictUserSessionCache,
  revokeAllUserSessions,
  revokeTokenHashes,
} from '../auth/session.service.js';
import { isDuplicateKey, subjectHash } from '../auth/identity.service.js';
import {
  authIdentities,
  availabilityBusyDates,
  availabilitySlots,
  gameMembers,
  games,
  identityTombstones,
  sessions,
  userProfiles,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';

type Provider = typeof authIdentities.$inferSelect.provider;

const DAY_MS = 86_400_000;
export type Clock = () => Date;
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
    publicId: u.publicId,
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
  let tz = input.timezone;
  if (!tz) {
    const [u] = await db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId));
    tz = u?.timezone;
  }
  if (!canRegister(input.birthDate, localDate(now(), tz))) {
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

export async function changeNickname(
  deps: AppDeps,
  userId: number,
  nickname: string,
): Promise<MeDto> {
  const { db } = deps;
  try {
    const [r] = await db
      .update(users)
      .set({ nickname })
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    if (r.affectedRows === 0) throw new AppError(401, 'UNAUTHENTICATED');
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError(409, 'NICKNAME_TAKEN');
    throw err;
  }
  await logEvent(db, { type: 'user.nickname_changed', userId });
  return getMe(deps, userId);
}

/**
 * Змінює пояс акаунта. Слоти календаря не перераховуються — лишаються тим самим «настінним»
 * часом у новому поясі (R5). Сесійний кеш пояса не містить (`SessionUser`), тож не чіпаємо.
 */
export async function changeTimezone(
  deps: AppDeps,
  userId: number,
  timezone: string,
): Promise<MeDto> {
  const { db } = deps;
  const from = await db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!u || u.status !== 'active') throw new AppError(401, 'UNAUTHENTICATED');
    if (u.timezone !== timezone) {
      await tx.update(users).set({ timezone }).where(eq(users.id, userId));
    }
    return u.timezone;
  });
  if (from !== timezone) {
    await logEvent(db, { type: 'user.timezone_changed', userId, payload: { from, to: timezone } });
  }
  return getMe(deps, userId);
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
    if (!canRegister(birthDate, localDate(current, u.timezone)))
      throw new AppError(422, 'AGE_TOO_LOW');
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
  // Хеші токенів збираємо в транзакції (до видалення рядків), щоб відкликання
  // не залежало лише від Redis-сету `usess:`. Рядок `users` лишається надгробком, тож
  // FK-каскади не спрацьовують: профіль, календар і членства в іграх видаляємо явно,
  // а активні ігри майстра скасовуємо (рішення R8).
  const { tokenHashes, cancelledGameIds } = await db.transaction(async (tx) => {
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
    const sess = await tx
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(userProfiles).where(eq(userProfiles.userId, userId));
    await tx.delete(availabilitySlots).where(eq(availabilitySlots.userId, userId));
    await tx.delete(availabilityBusyDates).where(eq(availabilityBusyDates.userId, userId));
    // Склад завершених/скасованих ігор лишаємо: історія інших гравців зберігається, а
    // видалений користувач показується анонімно. Виходимо лише з активних ігор.
    await tx.delete(gameMembers).where(
      and(
        eq(gameMembers.userId, userId),
        inArray(
          gameMembers.gameId,
          tx
            .select({ id: games.id })
            .from(games)
            .where(inArray(games.status, ['recruiting', 'started'])),
        ),
      ),
    );
    const active = await tx
      .select({ id: games.id, status: games.status })
      .from(games)
      .where(
        and(eq(games.gmUserId, userId), inArray(games.status, ['draft', 'recruiting', 'started'])),
      )
      .for('update');
    if (active.length) {
      await tx
        .update(games)
        .set({ status: 'cancelled', cancelledAt: now })
        .where(
          inArray(
            games.id,
            active.map((g) => g.id),
          ),
        );
    }
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
    return { tokenHashes: sess.map((r) => r.tokenHash), cancelledGameIds: active };
  });
  await revokeTokenHashes(deps, tokenHashes);
  await revokeAllUserSessions(deps, userId);
  for (const g of cancelledGameIds) {
    await logEvent(db, {
      type: 'game.cancelled',
      userId,
      entityType: 'game',
      entityId: g.id,
      payload: { from: g.status, to: 'cancelled', reason: 'account_deleted' },
    });
  }
  await logEvent(db, { type: 'user.deleted', userId });
}
