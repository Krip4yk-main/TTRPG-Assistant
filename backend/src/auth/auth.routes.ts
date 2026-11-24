import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authIdentities, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { linkIdentity, resolveLogin } from './identity.service.js';
import { verifyTelegramLogin } from './providers/telegram.js';
import { logoutHandlers, requireAuth } from './session.middleware.js';
import { createSession, setSessionCookie } from './session.service.js';

// Поля Telegram Login Widget; id/auth_date можуть прийти числом (JSON) — приводимо до рядка.
const telegramBody = z
  .object({
    id: z.union([z.string(), z.number()]),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    photo_url: z.string().optional(),
    auth_date: z.union([z.string(), z.number()]),
    hash: z.string(),
  })
  .strict()
  .transform((b) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = String(v);
    return out;
  });

/**
 * Єдиний auth-роутер (монтується на `/api/auth`).
 * Якщо TELEGRAM_BOT_TOKEN не задано, Telegram-маршрути відповідають 404 NOT_FOUND —
 * функція «не налаштована» і не відрізняється від відсутньої.
 */
export function authRouter(deps: AppDeps): Router {
  const { env, db } = deps;
  const router = Router();
  const auth = requireAuth(deps);
  const logout = logoutHandlers(deps);

  router.post('/logout', auth, logout.logout);
  router.post('/logout-all', auth, logout.logoutAll);

  const verify = (body: unknown) => {
    if (!env.TELEGRAM_BOT_TOKEN) throw new AppError(404, 'NOT_FOUND');
    const data = telegramBody.parse(body);
    return verifyTelegramLogin(
      data,
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_LOGIN_MAX_AGE_SEC,
      Math.floor(Date.now() / 1000),
    );
  };

  router.post('/telegram', async (req, res) => {
    const identity = verify(req.body);
    const { userId } = await resolveLogin(deps, identity);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
    if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
    const { token, expiresAt } = await createSession(deps, userId, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookie(res, token, expiresAt, env);
    // Тимчасовий «MeDto-lite»; повний MeDto визначає Task 9.
    res.json({
      user: { id: u.id, status: u.status, nickname: u.nickname, avatarUrl: u.avatarUrl },
    });
  });

  router.post('/telegram/link', auth, async (req, res) => {
    const identity = verify(req.body);
    await linkIdentity(deps, req.user!.userId, identity);
    const rows = await db
      .select({ provider: authIdentities.provider, displayName: authIdentities.displayName })
      .from(authIdentities)
      .where(eq(authIdentities.userId, req.user!.userId))
      .orderBy(authIdentities.id);
    res.json({ identities: rows });
  });

  return router;
}
