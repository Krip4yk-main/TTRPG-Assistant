import { and, eq, ne } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { authIdentities, users } from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { writeLog } from '../moderation/log.js';
import type { VerifiedIdentity } from './providers/provider.js';
import { evictUserSessionCache } from './session.service.js';

type Deps = Pick<AppDeps, 'env' | 'db' | 'redis'>;

/** Попередження «власник уже інший» — раз на процес (не на кожен вхід). */
let warnedOtherOwner = false;
let warnedNotPromotable = false;

/** Лише для тестів: дозволяє знову побачити попередження. */
export function resetOwnerBootstrapWarning(): void {
  warnedOtherOwner = false;
  warnedNotPromotable = false;
}

const activeOwner = and(eq(users.role, 'owner'), ne(users.status, 'deleted'));

/**
 * Бутстрап власника (План 20). Викликати ЛИШЕ з ідентичністю, перевіреною підписом Telegram
 * Login Widget (вхід `/api/auth/telegram` чи прив'язка `/api/auth/telegram/link`), — не з тіла
 * запиту бота чи інших джерел без підпису. Якщо Telegram id = `OWNER_TELEGRAM_ID`, а власника на
 * платформі ще немає, користувач `userId` стає власником.
 *
 * Атомарність: у транзакції спершу блокуюче читання власників (`FOR UPDATE` скануванням
 * `users` — колонка `role` без індексу, тож блокуються всі проглянуті рядки), потім рядок
 * цілі; два паралельні бутстрапи (чи бутстрап і `seed:owner`) серіалізуються, і другий бачить
 * уже призначеного власника. Забанений чи видалений акаунт власником не стає. Журнал
 * адміністрації `owner.bootstrap` (діяч — система) і подія `user.owner_bootstrapped`.
 * Власник уже є і це інша людина — нічого не змінюється, попередження в лог раз на процес.
 * Повертає, чи призначено власника цим викликом.
 */
export async function bootstrapOwner(
  deps: Deps,
  userId: number,
  identity: VerifiedIdentity,
  via: 'login' | 'link',
): Promise<boolean> {
  const { env, db } = deps;
  const ownerTelegramId = env.OWNER_TELEGRAM_ID;
  if (!ownerTelegramId || identity.provider !== 'telegram') return false;
  if (identity.subject !== ownerTelegramId) return false;

  // Дешева перевірка без блокувань: після бутстрапу кожен наступний вхід закінчується тут.
  const [existing] = await db.select({ id: users.id }).from(users).where(activeOwner).limit(1);
  if (existing) {
    if (existing.id !== userId) warnOtherOwner();
    return false;
  }

  const promoted = await db.transaction(async (tx) => {
    const owners = await tx.select({ id: users.id }).from(users).where(activeOwner).for('update');
    if (owners.length > 0) {
      if (!owners.some((o) => o.id === userId)) warnOtherOwner();
      return null;
    }
    const [u] = await tx
      .select({ role: users.role, status: users.status, isBanned: users.isBanned })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!u || u.status === 'deleted' || u.isBanned) {
      warnNotPromotable();
      return null;
    }
    // Захист у глибину: цей Telegram справді прив'язаний саме до цього акаунта.
    const [linked] = await tx
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.userId, userId),
          eq(authIdentities.provider, 'telegram'),
          eq(authIdentities.subject, ownerTelegramId),
        ),
      )
      .for('share');
    if (!linked) {
      warnNotPromotable();
      return null;
    }
    await tx.update(users).set({ role: 'owner' }).where(eq(users.id, userId));
    await writeLog(tx, {
      actorId: null,
      action: 'owner.bootstrap',
      targetType: 'user',
      targetId: userId,
      meta: { from: u.role, via },
    });
    return { from: u.role };
  });
  if (!promoted) return false;
  await evictUserSessionCache(deps, userId);
  await logEvent(db, { type: 'user.owner_bootstrapped', userId, payload: { via } });
  console.info(`[owner-bootstrap] user ${userId} is now the platform owner (via ${via})`);
  return true;
}

function warnOtherOwner(): void {
  if (warnedOtherOwner) return;
  warnedOtherOwner = true;
  console.warn(
    '[owner-bootstrap] OWNER_TELEGRAM_ID is set, but the platform already has another owner — ' +
      'ignored (use the owner transfer in the admin panel)',
  );
}

function warnNotPromotable(): void {
  if (warnedNotPromotable) return;
  warnedNotPromotable = true;
  console.warn(
    '[owner-bootstrap] the account with OWNER_TELEGRAM_ID cannot become the owner ' +
      '(banned, deleted or identity mismatch) — ignored',
  );
}
