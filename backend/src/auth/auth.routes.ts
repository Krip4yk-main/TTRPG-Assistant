import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { eq } from 'drizzle-orm';
import { randomNonce, randomPKCECodeVerifier, randomState } from 'openid-client';
import { z, ZodError } from 'zod';
import type { ErrorCode } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { authIdentities, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { devLoginEnabled, devLoginRouter, warnDevLoginMisconfig } from './dev-login.js';
import { linkIdentity, resolveLogin } from './identity.service.js';
import { getMe } from '../users/users.service.js';
import { bannedError, issueAppealToken } from '../appeals/appeals.service.js';
import { verifyTelegramLogin } from './providers/telegram.js';
import { defaultOAuthProviders } from './providers/index.js';
import { logoutHandlers, requireAuth } from './session.middleware.js';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
} from './session.service.js';

const OAUTH_TTL_SEC = 10 * 60;
const OAUTH_COOKIE = 'nri_oauth';
const OAUTH_COOKIE_PATH = '/api/auth';

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

/** Query callback-запиту як є (code, state, iss, ...) — для перевірок у openid-client. */
const callbackParamsOf = (req: Request): URLSearchParams =>
  new URL(req.originalUrl, 'http://callback.invalid').searchParams;

/** Безпечне для логів зведення помилки провайдера: без code/verifier/секретів і тіл відповідей. */
const oauthErrSummary = (err: unknown) => {
  if (!(err instanceof Error)) return { message: String(err) };
  const code = (err as { code?: unknown }).code;
  return {
    name: err.name,
    code: typeof code === 'string' ? code : undefined,
    message: err.message,
  };
};

type OAuthState = {
  codeVerifier: string;
  nonce: string;
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

  warnDevLoginMisconfig(env);
  if (devLoginEnabled(env)) router.use(devLoginRouter(deps, startSession));

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
    if (u.isBanned) throw await bannedError(deps, userId);
    await startSession(req, res, userId);
    res.json({ user: await getMe(deps, userId) });
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

  // ---- OAuth (Google, Discord) ----
  const providers = deps.oauthProviders ?? defaultOAuthProviders(env);
  const providerOf = (req: Request) => {
    const p = Object.hasOwn(providers, String(req.params.provider))
      ? providers[String(req.params.provider)]
      : undefined;
    if (!p) throw new AppError(404, 'NOT_FOUND');
    return p;
  };

  const oauthStart = async (req: Request, res: Response): Promise<void> => {
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
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const nonce = randomNonce();
    // URL будуємо ДО запису state/куки: збій провайдера (discovery) не лишає слідів.
    let authUrl: URL;
    try {
      authUrl = await provider.createAuthorizationUrl({ state, codeVerifier, nonce });
    } catch (err) {
      console.error(`[oauth] ${provider.id}: authorization URL failed`, oauthErrSummary(err));
      throw new AppError(502, 'OAUTH_STATE_INVALID');
    }
    const entry: OAuthState = {
      codeVerifier,
      nonce,
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
    res.redirect(authUrl.toString());
  };

  // start — top-level навігація: будь-яка AppError (401/403/404, невалідний mode)
  // віддається редиректом `/login?error=CODE` (для `mode=link` — `/account?error=CODE`).
  router.get('/:provider/start', async (req, res) => {
    try {
      await oauthStart(req, res);
    } catch (err) {
      const code =
        err instanceof AppError ? err.code : err instanceof ZodError ? 'VALIDATION' : null;
      if (!code) throw err;
      // Без сесії на `/account` не потрапити — веде на логін.
      const base = req.query.mode === 'link' && code !== 'UNAUTHENTICATED' ? '/account' : '/login';
      res.redirect(`${base}?error=${code}`);
    }
  });

  router.get('/:provider/callback', async (req, res) => {
    // Кука state очищається за будь-якого результату.
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
    const { code, state, error } = req.query;
    // Режим потоку: із запису state (якщо він ще є), інакше — login.
    let st: OAuthState | null = null;
    const modeOf = async (): Promise<OAuthState['mode']> => {
      if (st) return st.mode;
      if (typeof state !== 'string' || !state) return 'login';
      const raw = await deps.redis.get(`oauth:${state}`);
      if (!raw) return 'login';
      try {
        return (JSON.parse(raw) as OAuthState).mode === 'link' ? 'link' : 'login';
      } catch {
        return 'login';
      }
    };
    const fail = async (errCode: ErrorCode): Promise<void> => {
      const base = (await modeOf()) === 'link' ? '/account' : '/login';
      res.redirect(`${base}?error=${errCode}`);
    };
    const invalid = () => fail('OAUTH_STATE_INVALID');

    let provider;
    try {
      provider = providerOf(req);
    } catch (err) {
      if (err instanceof AppError) return fail(err.code);
      throw err;
    }
    // Звіряємо з кукою ДО GETDEL: чужий callback не спалює і не використовує state.
    // (Невідповідність кладе state недоступним лише для цього браузера; запис у Redis
    // залишається до TTL — ініціатор все ще може завершити потік у своєму браузері.)
    const bound = (req.cookies as Record<string, unknown> | undefined)?.[OAUTH_COOKIE];
    const boundOk = (): boolean => {
      if (typeof bound !== 'string' || typeof state !== 'string' || !state) return false;
      const a = Buffer.from(bound);
      const b = Buffer.from(state);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    // Провайдер повернув помилку (`?error=access_denied` — користувач скасував).
    if (typeof error === 'string' && error) {
      const mode = await modeOf();
      if (boundOk()) await deps.redis.del(`oauth:${state as string}`);
      const errCode: ErrorCode =
        error === 'access_denied' ? 'OAUTH_CANCELLED' : 'OAUTH_STATE_INVALID';
      return res.redirect(`${mode === 'link' ? '/account' : '/login'}?error=${errCode}`);
    }
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) return invalid();
    if (!boundOk()) return invalid();
    // GETDEL: запис одноразовий навіть при паралельних callback-ах.
    const raw = await deps.redis.getdel(`oauth:${state}`);
    if (!raw) return invalid();
    st = JSON.parse(raw) as OAuthState;
    if (st.mode === 'link' && req.user?.userId !== st.userId) return invalid();

    let identity;
    try {
      identity = await provider.exchange({
        callbackParams: callbackParamsOf(req),
        codeVerifier: st.codeVerifier,
        state,
        nonce: st.nonce,
      });
    } catch (err) {
      console.error(`[oauth] ${provider.id}: code exchange failed`, oauthErrSummary(err));
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
      if (u.isBanned) {
        const { appealToken, appealSent, appealStatus } = await issueAppealToken(deps, userId);
        const sent = appealSent ? `&sent=1&appealStatus=${appealStatus}` : '';
        return res.redirect(`/login?error=ACCOUNT_BANNED&appeal=${appealToken}${sent}`);
      }
      await startSession(req, res, userId);
      return res.redirect(u.status === 'pending' ? '/complete-profile' : safeReturnTo(st.returnTo));
    } catch (err) {
      // Top-level навігація: будь-яка AppError віддається редиректом, не JSON.
      if (err instanceof AppError) return res.redirect(`${errBase}?error=${err.code}`);
      throw err;
    }
  });

  return router;
}
