import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { linkIdentity } from '../auth/identity.service.js';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { hasValidInternalKey } from '../http/security.js';
import { getMe } from '../users/users.service.js';
import { telegramActionsRouter } from './telegram-actions.routes.js';
import { telegramOutboxRouter } from './telegram-outbox.routes.js';

export const TG_LINK_PREFIX = 'tglink:';

/** Перевірка `X-Internal-Key` (довжина — перед `timingSafeEqual`). */
export function requireInternalKey(deps: Pick<AppDeps, 'env'>): RequestHandler {
  return (req, _res, next) => {
    if (!hasValidInternalKey(req, deps.env.INTERNAL_API_KEY)) {
      next(new AppError(401, 'UNAUTHENTICATED'));
      return;
    }
    next();
  };
}

const linkBody = z.object({
  token: z.string().min(1).max(128),
  telegramId: z.union([z.string().min(1).max(32), z.number().int()]),
  displayName: z.string().min(1).max(255),
});

/** Монтується на `/api/internal` (виклики бота, без cookie/CSRF). */
export function internalRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(requireInternalKey(deps));

  router.post('/telegram/link', async (req, res) => {
    const input = linkBody.parse(req.body);
    // GETDEL: токен одноразовий, навіть якщо прив'язка далі не вдасться.
    const raw = await deps.redis.getdel(`${TG_LINK_PREFIX}${input.token}`);
    const userId = raw === null ? NaN : Number(raw);
    if (!Number.isInteger(userId)) throw new AppError(404, 'NOT_FOUND');
    // Токен міг пережити видалення/бан акаунта.
    const [owner] = await deps.db
      .select({ status: users.status, isBanned: users.isBanned })
      .from(users)
      .where(eq(users.id, userId));
    if (!owner || owner.status !== 'active' || owner.isBanned) {
      throw new AppError(404, 'NOT_FOUND');
    }
    await linkIdentity(deps, userId, {
      provider: 'telegram',
      subject: String(input.telegramId),
      displayName: input.displayName,
    });
    deps.realtime?.toUser(userId, 'identity.linked', { provider: 'telegram' });
    const me = await getMe(deps, userId);
    res.json({ ok: true, nickname: me.nickname });
  });

  router.use('/telegram/outbox', telegramOutboxRouter(deps));
  router.use('/telegram/action', telegramActionsRouter(deps));

  return router;
}
