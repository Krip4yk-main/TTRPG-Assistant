import { and, eq, isNull } from 'drizzle-orm';
import { X_CARD_COOLDOWN_SEC, xCardWindow } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { gameMembers, games, gameSessions } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { onceRemainingSec, releaseOnce, takeOnce } from '../http/security.js';
import {
  createNotification,
  emitNotificationsNew,
} from '../notifications/notifications.service.js';

/**
 * Чи доступна X-Card на сесіях гри глядачу: увімкнена майстром і глядач — не майстер.
 * Передумова: членство глядача (активний учасник) перевіряє виклик — сервіс сесій віддає DTO
 * лише майстру й учасникам, `raiseXCard` — окремою перевіркою; сама функція членства не знає.
 */
export const xCardFor = (
  game: { gmUserId: number; safetyTools: readonly string[] },
  viewerId: number,
): boolean => game.gmUserId !== viewerId && game.safetyTools.includes('x_card');

/**
 * Ключ ліміту в Redis (1 натискання / 5 хв на користувача на сесію). userId тут лише
 * тимчасово (TTL 5 хв) — у БД, сповіщеннях і логах того, хто натиснув, немає.
 */
const limitKey = (sessionId: number, userId: number): string => `xcard:${sessionId}:${userId}`;

/**
 * X-Card: анонімний сигнал майстру `session.x_card` (сайт + Telegram, тихі години не
 * затримують). Лише активний учасник (майстер — 403 `FORBIDDEN`, сторонній чи колишній — 403
 * `NOT_A_MEMBER`, прихована гра — 404), гра набирає чи йде й майстер увімкнув `x_card` (інакше
 * 409 `X_CARD_DISABLED`), сесія не скасована і зараз у вікні `xCardWindow` (інакше 409
 * `X_CARD_NOT_NOW`). Повтор раніше ніж за 5 хв — 429 `RATE_LIMITED` з `retryAfterSec`.
 * Хто натиснув, не зберігається: сповіщення без `actor`, без події в журналі.
 */
export async function raiseXCard(
  deps: Pick<AppDeps, 'db' | 'redis' | 'env' | 'realtime'>,
  userId: number,
  sessionId: number,
  now: Date = new Date(),
): Promise<void> {
  const { db, redis } = deps;
  const [r] = await db
    .select({ game: games, session: gameSessions })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  const { game, session } = r;
  if (game.gmUserId === userId) throw new AppError(403, 'FORBIDDEN');
  if (isHiddenFromNonGm(game)) throw new AppError(404, 'NOT_FOUND');
  const [m] = await db
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, game.id),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  if (!m) throw new AppError(403, 'NOT_A_MEMBER');
  if (!xCardFor(game, userId)) throw new AppError(409, 'X_CARD_DISABLED');
  const { from, to } = xCardWindow(session);
  const running = game.status === 'recruiting' || game.status === 'started';
  if (!running || session.status === 'cancelled' || now < from || now > to) {
    throw new AppError(409, 'X_CARD_NOT_NOW');
  }
  const key = limitKey(sessionId, userId);
  if (!(await takeOnce(redis, key, X_CARD_COOLDOWN_SEC))) {
    throw new AppError(429, 'RATE_LIMITED', {
      retryAfterSec: await onceRemainingSec(redis, key, X_CARD_COOLDOWN_SEC),
    });
  }
  let row;
  try {
    row = await db.transaction((tx) =>
      createNotification(deps, tx, {
        userId: game.gmUserId,
        type: 'session.x_card',
        category: 'sessions',
        params: {
          gameId: game.id,
          gameTitle: game.title,
          sessionId,
          startsAt: session.startsAt.toISOString(),
          startWindowMinutes: session.startWindowMinutes,
        },
        entityType: 'session',
        entityId: sessionId,
      }),
    );
  } catch (err) {
    // Сигнал не дійшов — ліміт не має заважати спробувати ще раз.
    await releaseOnce(redis, key);
    throw err;
  }
  emitNotificationsNew(deps, [row]);
}
