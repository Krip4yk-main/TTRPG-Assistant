import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { evictUserSessionCache } from '../auth/session.service.js';
import { users } from '../db/schema/index.js';

/**
 * Ставить is_banned і скидає Redis-кеш сесій, тож бан діє з наступного ж запиту:
 * requireAuth бачить isBanned -> 403 ACCOUNT_BANNED і викликає revokeAllUserSessions
 * (далі 401). Рядки БД тут свідомо лишаються, щоб перший запит отримав зрозумілий 403.
 */
export async function banUser(deps: AppDeps, userId: number): Promise<void> {
  await deps.db.update(users).set({ isBanned: true }).where(eq(users.id, userId));
  await evictUserSessionCache(deps, userId);
}
