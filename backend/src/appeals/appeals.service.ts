import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appealInputSchema } from '@nri/shared';
import type { BannedLoginDetails } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { logEvent } from '../events/events.service.js';
import { banAppealStatus, createBanAppeal } from '../moderation/appeals.service.js';

const APPEAL_TTL_SEC = 30 * 60;
const key = (token: string) => `appeal:${token}`;

/**
 * Обмежений токен апеляції для забаненого користувача: Redis `appeal:<token>` → userId.
 * Дає право лише на один `POST /api/appeals`; сесії не створює. `appealStatus` — статус
 * апеляції на чинну санкцію-бан (екран бану).
 */
export async function issueAppealToken(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  userId: number,
): Promise<BannedLoginDetails> {
  const appealToken = randomBytes(24).toString('base64url');
  await deps.redis.set(key(appealToken), String(userId), 'EX', APPEAL_TTL_SEC);
  const appealStatus = await banAppealStatus(deps.db, userId);
  return { appealToken, appealSent: appealStatus !== null, appealStatus };
}

/** 403 ACCOUNT_BANNED із токеном апеляції в `details`. */
export async function bannedError(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  userId: number,
): Promise<AppError> {
  return new AppError(403, 'ACCOUNT_BANNED', await issueAppealToken(deps, userId));
}

/**
 * Апеляція: одна на чинну санкцію-бан (`sanction_appeals`; бан лише прапорцем отримує системну
 * санкцію — `activeBanSanction`). Токен спалюється лише остаточною
 * відповіддю (201, 409, 403, 401 для видаленого акаунта); невалідне тіло чи неочікувана
 * помилка (5xx) лишають його дійсним до кінця TTL — можна повторити.
 */
export async function createAppeal(deps: AppDeps, rawBody: unknown): Promise<{ id: number }> {
  const input = appealInputSchema.parse(rawBody);
  const tokenKey = key(input.appealToken);
  const raw = await deps.redis.get(tokenKey);
  const userId = raw === null ? NaN : Number(raw);
  if (!Number.isSafeInteger(userId)) throw new AppError(401, 'UNAUTHENTICATED');
  const burn = () => deps.redis.del(tokenKey);
  const [u] = await deps.db.select().from(users).where(eq(users.id, userId));
  if (!u || u.status === 'deleted') {
    await burn();
    throw new AppError(401, 'UNAUTHENTICATED');
  }
  if (!u.isBanned) {
    await burn();
    throw new AppError(403, 'FORBIDDEN');
  }
  let created: { id: number; sanctionId: number };
  try {
    created = await createBanAppeal(deps, userId, input.message);
  } catch (err) {
    // Остаточні відповіді спалюють токен (як і перевірки вище).
    const final = ['APPEAL_EXISTS', 'SANCTION_NOT_ACTIVE', 'FORBIDDEN', 'UNAUTHENTICATED'];
    if (err instanceof AppError && final.includes(err.code)) await burn();
    throw err;
  }
  const { id, sanctionId } = created;
  await burn();
  await logEvent(deps.db, {
    type: 'appeal.created',
    userId,
    entityType: 'sanction_appeal',
    entityId: id,
    payload: { sanctionId, banEpoch: u.banEpoch },
  });
  return { id };
}
