import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { linkIdentity } from '../auth/identity.service.js';
import { AppError } from '../http/errors.js';
import { getMe } from '../users/users.service.js';

export const TG_LINK_PREFIX = 'tglink:';

/** Перевірка `X-Internal-Key` (довжина — перед `timingSafeEqual`). */
export function requireInternalKey(deps: Pick<AppDeps, 'env'>): RequestHandler {
  const expected = Buffer.from(deps.env.INTERNAL_API_KEY);
  return (req, _res, next) => {
    const given = Buffer.from(req.get('x-internal-key') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
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
    await linkIdentity(deps, userId, {
      provider: 'telegram',
      subject: String(input.telegramId),
      displayName: input.displayName,
    });
    deps.realtime?.toUser(userId, 'identity.linked', { provider: 'telegram' });
    const me = await getMe(deps, userId);
    res.json({ ok: true, nickname: me.nickname });
  });

  return router;
}
