import { and, eq, sql } from 'drizzle-orm';
import {
  BIRTH_DATE_CHANGE_COOLDOWN_DAYS,
  ME_CHANGED_EVENT,
  availableThemes,
  canRegister,
  localDate,
  resolveTheme,
  type CompleteProfileInput,
  type MeChangeScope,
  type MeChangedPing,
  type MeDto,
  type ThemeId,
  type UpdateUiPrefsInput,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  evictUserSessionCache,
  revokeAllUserSessions,
  revokeTokenHashes,
} from '../auth/session.service.js';
import { isDuplicateKey } from '../db/errors.js';
import { upsertTombstone } from '../auth/identity.service.js';
import {
  authIdentities,
  availabilityBusyDates,
  calendarPinnedGames,
  availabilitySlots,
  sessions,
  userProfiles,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { AppError } from '../http/errors.js';
import { cancelPendingOutbox } from '../notifications/telegram-outbox.js';
import {
  leaveCandidates,
  lockLeaveGames,
  logLeaveCascade,
  pingLeaveCascade,
  runLeaveCascade,
} from './leave-cascade.js';

type Provider = typeof authIdentities.$inferSelect.provider;

const DAY_MS = 86_400_000;
export type Clock = () => Date;
/**
 * Низькорівневий бан без санкції (тести, аварійний доступ): лише прапорець. Модерація банить
 * через `imposeSanction` (`global_ban`) — там і каскад, і надгробки, і журнал.
 * Ставить is_banned і скидає Redis-кеш сесій, тож бан діє з наступного ж запиту:
 * requireAuth бачить isBanned -> 403 ACCOUNT_BANNED і викликає revokeAllUserSessions
 * (далі 401). Рядки БД тут свідомо лишаються, щоб перший запит отримав зрозумілий 403.
 */
export async function banUser(deps: AppDeps, userId: number): Promise<void> {
  // Новий період бану (ban_epoch+1) лише для незабаненого: повторний виклик не відкриває
  // ще одну апеляцію.
  await deps.db
    .update(users)
    .set({ isBanned: true, banEpoch: sql`${users.banEpoch} + 1` })
    .where(and(eq(users.id, userId), eq(users.isBanned, false)));
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
    uiTheme: resolveTheme(u.uiTheme, u.role),
    availableThemes: availableThemes(u.role),
    uiPrefs: { tearAnimation: u.qbTearAnimation },
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

/**
 * Зберігає обраний дизайн. Роль перечитується з БД під локом рядка (кеш сесії може відставати),
 * недоступний ролі дизайн → 403 `THEME_NOT_AVAILABLE`.
 */
export async function changeTheme(deps: AppDeps, userId: number, theme: ThemeId): Promise<MeDto> {
  await deps.db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!u || u.status !== 'active') throw new AppError(401, 'UNAUTHENTICATED');
    if (!availableThemes(u.role).includes(theme)) throw new AppError(403, 'THEME_NOT_AVAILABLE');
    await tx.update(users).set({ uiTheme: theme }).where(eq(users.id, userId));
  });
  pingMeChanged(deps, userId, 'appearance');
  return getMe(deps, userId);
}

/** Зберігає налаштування вигляду (`PATCH /api/me/ui-prefs`). */
export async function changeUiPrefs(
  deps: AppDeps,
  userId: number,
  prefs: UpdateUiPrefsInput,
): Promise<MeDto> {
  await deps.db
    .update(users)
    .set({ qbTearAnimation: prefs.tearAnimation })
    .where(eq(users.id, userId));
  pingMeChanged(deps, userId, 'appearance');
  return getMe(deps, userId);
}

/**
 * Пінг `me.changed {scope}` в особисту кімнату — інші сесії користувача перезапитають
 * `/api/me`. Лише після коміту; збій емісії не валить запит; без realtime — нічого.
 */
function pingMeChanged(
  deps: Pick<Partial<AppDeps>, 'realtime'>,
  userId: number,
  scope: MeChangeScope,
): void {
  try {
    deps.realtime?.toUser(userId, ME_CHANGED_EVENT, { scope } satisfies MeChangedPing);
  } catch (err) {
    console.error('[realtime] me.changed emit failed', err);
  }
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
    const [u] = await tx
      .select({ isBanned: users.isBanned })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const rows = await tx
      .select({
        id: authIdentities.id,
        provider: authIdentities.provider,
        subject: authIdentities.subject,
      })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    const target = rows.find((r) => r.provider === provider);
    if (!target) throw new AppError(404, 'NOT_FOUND');
    if (rows.length <= 1) throw new AppError(409, 'LAST_IDENTITY');
    // Надгробок на кожне відв'язування: бан (зараз чи пізніше) закриває цій ідентичності
    // повторну реєстрацію й прив'язку (ухилення від бану).
    await upsertTombstone(tx, deps.env.IDENTITY_PEPPER, userId, u?.isBanned ?? false, target);
    await tx.delete(authIdentities).where(eq(authIdentities.id, target.id));
    // Ще не надіслане в цей чат більше не доставляємо.
    if (provider === 'telegram') await cancelPendingOutbox(tx, userId, 'unlinked');
  });
  await logEvent(db, { type: 'identity.unlinked', userId, payload: { provider } });
}

export async function deleteAccount(deps: AppDeps, userId: number): Promise<void> {
  const { db, env } = deps;
  const now = new Date();
  // Хеші токенів збираємо в транзакції (до видалення рядків), щоб відкликання
  // не залежало лише від Redis-сету `usess:`. Рядок `users` лишається надгробком, тож
  // FK-каскади не спрацьовують: профіль і календар видаляємо явно, а вихід з ігор, заявки й
  // скасування своїх активних ігор (рішення R8) — спільний каскад `leave-cascade.ts` (той самий,
  // що для глобального бану), з його порядком блокувань: ігри → `users` → заявки/членства.
  const lockIds = await leaveCandidates(db, userId);
  const result = await db.transaction(async (tx) => {
    const active = await lockLeaveGames(tx, userId, lockIds);
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
    if (u.role === 'owner') throw new AppError(409, 'OWNER_CANNOT_DELETE');
    const identities = await tx
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId));
    for (const i of identities) {
      await upsertTombstone(tx, env.IDENTITY_PEPPER, userId, u.isBanned, i);
    }
    await tx.delete(authIdentities).where(eq(authIdentities.userId, userId));
    await cancelPendingOutbox(tx, userId, 'unlinked');
    const sess = await tx
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(userProfiles).where(eq(userProfiles.userId, userId));
    await tx.delete(availabilitySlots).where(eq(availabilitySlots.userId, userId));
    await tx.delete(availabilityBusyDates).where(eq(availabilityBusyDates.userId, userId));
    await tx.delete(calendarPinnedGames).where(eq(calendarPinnedGames.userId, userId));
    const cascade = await runLeaveCascade(tx, userId, active, now, 'account_deleted');
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
    return { tokenHashes: sess.map((r) => r.tokenHash), cascade };
  });
  await revokeTokenHashes(deps, result.tokenHashes);
  await revokeAllUserSessions(deps, userId);
  await logLeaveCascade(db, userId, result.cascade, 'account_deleted');
  await logEvent(db, { type: 'user.deleted', userId });
  await pingLeaveCascade(deps, userId, result.cascade);
}
