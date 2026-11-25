import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appealInputSchema } from '@nri/shared';
import type { BannedLoginDetails } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { banAppeals, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { isDuplicateKey } from '../auth/identity.service.js';
import { logEvent } from '../events/events.service.js';

const APPEAL_TTL_SEC = 30 * 60;
const key = (token: string) => `appeal:${token}`;

/**
 * Обмежений токен апеляції для забаненого користувача: Redis `appeal:<token>` → userId.
 * Дає право лише на один `POST /api/appeals`; сесії не створює.
 */
export async function issueAppealToken(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  userId: number,
): Promise<BannedLoginDetails> {
  const appealToken = randomBytes(24).toString('base64url');
  await deps.redis.set(key(appealToken), String(userId), 'EX', APPEAL_TTL_SEC);
  const [u] = await deps.db
    .select({ banEpoch: users.banEpoch })
    .from(users)
    .where(eq(users.id, userId));
  const sent = u
    ? await deps.db
        .select({ id: banAppeals.id })
        .from(banAppeals)
        .where(and(eq(banAppeals.userId, userId), eq(banAppeals.banEpoch, u.banEpoch)))
    : [];
  return { appealToken, appealSent: sent.length > 0 };
}

/** 403 ACCOUNT_BANNED із токеном апеляції в `details`. */
export async function bannedError(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  userId: number,
): Promise<AppError> {
  return new AppError(403, 'ACCOUNT_BANNED', await issueAppealToken(deps, userId));
}

/**
 * Апеляція: одна на період бану (`users.ban_epoch`). Токен спалюється лише остаточною
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
  let id: number;
  try {
    const [res] = await deps.db
      .insert(banAppeals)
      .values({ userId, banEpoch: u.banEpoch, message: input.message });
    id = res.insertId;
  } catch (err) {
    if (isDuplicateKey(err)) {
      await burn();
      throw new AppError(409, 'APPEAL_EXISTS');
    }
    throw err;
  }
  await burn();
  await logEvent(deps.db, {
    type: 'appeal.created',
    userId,
    entityType: 'ban_appeal',
    entityId: id,
    payload: { banEpoch: u.banEpoch },
  });
  return { id };
}
