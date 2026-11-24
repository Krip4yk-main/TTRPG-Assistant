import { generateCodeVerifier, generateState } from 'arctic';
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authIdentities, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { linkIdentity, resolveLogin } from './identity.service.js';
import { verifyTelegramLogin } from './providers/telegram.js';
import { defaultOAuthProviders } from './providers/index.js';
import { logoutHandlers, requireAuth } from './session.middleware.js';
import { createSession, revokeAllUserSessions, revokeSession, setSessionCookie } from './session.service.js';

const OAUTH_TTL_SEC = 10 * 60;
const OAUTH_COOKIE = 'nri_oauth';
const OAUTH_COOKIE_PATH = '/api/auth';
const REDIRECTABLE_ERRORS = new Set([
  'IDENTITY_TAKEN',
  'IDENTITY_BANNED',
  'ACCOUNT_BANNED',
  'PROVIDER_ALREADY_LINKED',
]);

/** Лише відносний шлях усередині сайту: `/x`, але не `//host` і не `/\\host`. */
const safeReturnTo = (v: unknown): string => {
  if (typeof v !== 'string') return '/';
  const ok = (x: string) => /^\/(?![/\\])/.test(x);
  if (!ok(v)) return '/';
  // Подвійне кодування (`/%5Cevil.com`): перевіряємо й декодований вигляд.
  try {
    if (!ok(decodeURIComponent(v))) return '/';
  } catch {
    return '/';
  }
  return v;
};

type OAuthState = {
  codeVerifier: string;
  mode: 'login' | 'link';
  userId?: number;
  returnTo: string;
};

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
  .catchall(z.union([z.string(), z.number()]))
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

  // Новий вхід завжди відкликає сесію, з якою прийшов запит (проти session fixation).
  const startSession = async (req: Request, res: Response, userId: number): Promise<void> => {
    if (req.sessionToken) await revokeSession(deps, req.sessionToken, req.user?.userId);
    const { token, expiresAt } = await createSession(deps, userId, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    setSessionCookie(res, token, expiresAt, env);
  };

  const requireTelegram: RequestHandler = (_req, _res, next) => {
    if (!env.TELEGRAM_BOT_TOKEN) throw new AppError(404, 'NOT_FOUND');
    next();
  };

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
    await startSession(req, res, userId);
    // Тимчасовий «MeDto-lite»; повний MeDto визначає Task 9.
    res.json({
      user: { id: u.id, status: u.status, nickname: u.nickname, avatarUrl: u.avatarUrl },
    });
  });

  router.post('/telegram/link', requireTelegram, auth, async (req, res) => {
    const identity = verify(req.body);
    await linkIdentity(deps, req.user!.userId, identity);
    const rows = await db
      .select({ provider: authIdentities.provider, displayName: authIdentities.displayName })
      .from(authIdentities)
      .where(eq(authIdentities.userId, req.user!.userId))
      .orderBy(authIdentities.id);
    res.json({ identities: rows });
  });

  // ---- OAuth (Google; Discord пізніше) ----
  const providers = deps.oauthProviders ?? defaultOAuthProviders(env);
  const providerOf = (req: Request) => {
    const p = Object.hasOwn(providers, String(req.params.provider))
      ? providers[String(req.params.provider)]
      : undefined;
    if (!p) throw new AppError(404, 'NOT_FOUND');
    return p;
  };

  router.get('/:provider/start', async (req, res) => {
    const provider = providerOf(req);
    const q = z
      .object({ mode: z.enum(['login', 'link']).default('login') })
      .parse({ mode: req.query.mode });
    if (q.mode === 'link') {
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED');
      if (req.user.isBanned) {
        await revokeAllUserSessions(deps, req.user.userId);
        throw new AppError(403, 'ACCOUNT_BANNED');
      }
    }
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const entry: OAuthState = {
      codeVerifier,
      mode: q.mode,
      returnTo: safeReturnTo(req.query.returnTo),
      ...(q.mode === 'link' ? { userId: req.user!.userId } : {}),
    };
    await deps.redis.set(`oauth:${state}`, JSON.stringify(entry), 'EX', OAUTH_TTL_SEC);
    // Прив'язка state до браузера: проти login CSRF (чужий callback у браузері жертви).
    res.cookie(OAUTH_COOKIE, state, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_TTL_SEC * 1000,
    });
    res.redirect(provider.createAuthorizationUrl(state, codeVerifier).toString());
  });

  router.get('/:provider/callback', async (req, res) => {
    const provider = providerOf(req);
    // Кука state очищається за будь-якого результату.
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
    const invalid = () => res.redirect('/login?error=OAUTH_STATE_INVALID');
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) return invalid();
    // Звіряємо з кукою ДО GETDEL: чужий callback не спалює і не використовує state.
    // (Невідповідність кладе state недоступним лише для цього браузера; запис у Redis
    // залишається до TTL — ініціатор все ще може завершити потік у своєму браузері.)
    const bound = (req.cookies as Record<string, unknown> | undefined)?.[OAUTH_COOKIE];
    if (typeof bound !== 'string') return invalid();
    const a = Buffer.from(bound);
    const b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return invalid();
    // GETDEL: запис одноразовий навіть при паралельних callback-ах.
    const raw = await deps.redis.getdel(`oauth:${state}`);
    if (!raw) return invalid();
    const st = JSON.parse(raw) as OAuthState;
    if (st.mode === 'link' && req.user?.userId !== st.userId) return invalid();

    let identity;
    try {
      identity = await provider.exchange(code, st.codeVerifier);
    } catch {
      return invalid();
    }
    const errBase = st.mode === 'link' ? '/account' : '/login';
    try {
      if (st.mode === 'link') {
        await linkIdentity(deps, st.userId!, identity);
        return res.redirect(safeReturnTo(st.returnTo));
      }
      const { userId } = await resolveLogin(deps, identity);
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.status === 'deleted') return res.redirect('/login?error=UNAUTHENTICATED');
      if (u.isBanned) throw new AppError(403, 'ACCOUNT_BANNED');
      await startSession(req, res, userId);
      return res.redirect(u.status === 'pending' ? '/complete-profile' : safeReturnTo(st.returnTo));
    } catch (err) {
      if (err instanceof AppError && REDIRECTABLE_ERRORS.has(err.code)) {
        return res.redirect(`${errBase}?error=${err.code}`);
      }
      throw err;
    }
  });

  return router;
}
