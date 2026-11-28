import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { devCodeLoginSchema, devLoginSchema, type EventType } from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { DevLoginCode, Env } from '../config/env.js';
import { authIdentities, events, users } from '../db/schema/index.js';
import { AppError } from '../http/errors.js';
import { getMe } from '../users/users.service.js';
import { isDuplicateKey } from '../db/errors.js';
import { resolveLogin } from './identity.service.js';
import { bannedError } from '../appeals/appeals.service.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Лише адреса TCP-сокета; X-Forwarded-* і req.ip ігноруються навмисно. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

/** Запит із проксі-заголовками вважається не локальним (reverse proxy на тому ж хості). */
export function isLocalRequest(req: Pick<Request, 'socket' | 'headers'>): boolean {
  if (PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined)) return false;
  const addr = req.socket?.remoteAddress;
  return typeof addr === 'string' && LOOPBACK.has(addr);
}

type DevEnv = Pick<
  Env,
  | 'NODE_ENV'
  | 'DEPLOY_ENV'
  | 'DEV_LOGIN_ENABLED'
  | 'DEV_LOGIN_CODES'
  | 'DEV_OWNER_KEY'
  | 'TRUST_PROXY'
>;

/**
 * Режим dev-входу:
 * - `local` — форма `POST /api/auth/dev-login` лише з localhost (NODE_ENV=development, без проксі);
 * - `beta` — `POST /api/auth/dev-login/code` лише з кодом із `DEV_LOGIN_CODES` (DEPLOY_ENV=dev);
 * - `null` — вимкнено, маршрути не монтуються (на `prod` — завжди; з DEV_* прод і не стартує).
 */
export type DevLoginMode = 'local' | 'beta' | null;

export function devLoginMode(env: DevEnv): DevLoginMode {
  if (!env.DEV_LOGIN_ENABLED) return null;
  if (env.DEPLOY_ENV === 'local') {
    return env.NODE_ENV === 'development' && env.TRUST_PROXY === 0 ? 'local' : null;
  }
  if (env.DEPLOY_ENV === 'dev') return env.DEV_LOGIN_CODES.length > 0 ? 'beta' : null;
  return null;
}

/** Шлях входу за кодом (відносно `/api/auth`). */
export const DEV_LOGIN_CODE_PATH = '/dev-login/code';

/** Гучне попередження, якщо налаштування dev-входу не діють або діють не так, як очікують. */
export function warnDevLoginMisconfig(env: DevEnv): void {
  if (env.DEPLOY_ENV === 'local' && env.DEV_LOGIN_ENABLED && !devLoginMode(env)) {
    console.warn(
      '[SECURITY] DEV_LOGIN_ENABLED=true, але NODE_ENV!=development або TRUST_PROXY>0: dev-вхід вимкнено. ' +
        'Не вмикайте DEV_LOGIN_ENABLED поза локальною розробкою.',
    );
  }
  if (env.DEPLOY_ENV === 'dev') {
    if (env.DEV_OWNER_KEY) {
      console.warn('[SECURITY] DEV_OWNER_KEY на DEPLOY_ENV=dev не діє: приберіть його з .env.');
    }
    if (devLoginMode(env) === 'beta' && env.TRUST_PROXY === 0) {
      console.warn(
        '[dev-login] TRUST_PROXY=0 за reverse proxy: ліміт спроб коду рахується спільно для всіх.',
      );
    }
  }
}

function ownerKeyMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * Номер коду, що збігся (або -1). Порівнюються SHA-256 (однакова довжина) з усіма кодами без
 * раннього виходу — час не залежить ні від збігу, ні від довжини чи префікса введеного.
 */
export function matchDevLoginCode(codes: readonly DevLoginCode[], given: string): number {
  const g = digest(given);
  let found = -1;
  for (const [i, c] of codes.entries()) {
    if (timingSafeEqual(digest(c.code), g) && found === -1) found = i;
  }
  return given.length > 0 ? found : -1;
}

const bodySchema = devLoginSchema.extend({
  nickname: devLoginSchema.shape.nickname.max(32),
});

type StartSession = (req: Request, res: Response, userId: number) => Promise<void>;

/** `local`: власник — лише за `DEV_OWNER_KEY`. `beta`: персонал не входить узагалі. */
type Policy = { mode: 'local'; ownerKey: string | undefined } | { mode: 'beta' };

/**
 * Знаходить або створює dev-акаунт за нікнеймом і перевіряє, чи можна в нього ввійти; повертає
 * id і чи створено його цим запитом. Сесію не відкриває — це робить викликач (на беті — лише
 * після запису в журнал).
 */
async function devSignIn(
  deps: AppDeps,
  nickname: string,
  policy: Policy,
): Promise<{ userId: number; created: boolean }> {
  const { env, db } = deps;
  const [viaIdentity] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, 'dev'), eq(authIdentities.subject, nickname)));
  let userId = viaIdentity?.userId ?? null;
  if (userId === null) {
    const [byNick] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.nickname, nickname));
    // Локально власник (напр. із seed) без dev-ідентичності входить лише за ключем;
    // на беті чужий (не dev) акаунт недоступний нікому.
    if (byNick && (policy.mode === 'beta' || byNick.role !== 'owner')) {
      throw new AppError(409, 'NICKNAME_TAKEN');
    }
    userId = byNick?.id ?? null;
  }

  if (userId !== null) {
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (!u || u.status === 'deleted') throw new AppError(401, 'UNAUTHENTICATED');
    // Код тестера не дає прав персоналу: dev-акаунт із роллю персоналу — лише справжній вхід.
    if (policy.mode === 'beta' && u.role !== 'user') throw new AppError(403, 'FORBIDDEN');
    if (
      policy.mode === 'local' &&
      u.role === 'owner' &&
      !ownerKeyMatches(env.DEV_OWNER_KEY, policy.ownerKey)
    ) {
      throw new AppError(403, 'FORBIDDEN');
    }
    if (u.isBanned) throw await bannedError(deps, u.id);
    return { userId, created: false };
  }

  const created = await resolveLogin(deps, {
    provider: 'dev',
    subject: nickname,
    displayName: nickname,
  });
  try {
    await db
      .update(users)
      .set({ status: 'active', nickname, birthDate: '2000-01-01' })
      .where(eq(users.id, created.userId));
  } catch (err) {
    // Гонка за нікнейм: прибираємо лише те, що створив цей запит.
    if (created.isNew) {
      await db.delete(authIdentities).where(eq(authIdentities.userId, created.userId));
      await db.delete(users).where(eq(users.id, created.userId));
    }
    if (isDuplicateKey(err)) throw new AppError(409, 'NICKNAME_TAKEN');
    throw err;
  }
  return { userId: created.userId, created: created.isNew };
}

/** Монтувати лише коли `devLoginMode(env)` не `null`; монтується лише маршрут свого режиму. */
export function devLoginRouter(deps: AppDeps, startSession: StartSession): Router {
  const { env, db } = deps;
  const router = Router();
  const mode = devLoginMode(env);

  if (mode === 'local') {
    // Не локальний запит → 404, як невідомий маршрут.
    router.post('/dev-login', async (req, res) => {
      if (!isLocalRequest(req)) throw new AppError(404, 'NOT_FOUND');
      const { nickname, ownerKey } = bodySchema.parse(req.body);
      const { userId } = await devSignIn(deps, nickname, { mode: 'local', ownerKey });
      await startSession(req, res, userId);
      res.json({ user: await getMe(deps, userId) });
    });
  }

  if (mode === 'beta') {
    // Код перевіряється першим: без нього — 403 без підказок (ще до розбору нікнейма).
    router.post(DEV_LOGIN_CODE_PATH, async (req, res) => {
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const codeIndex = matchDevLoginCode(
        env.DEV_LOGIN_CODES,
        typeof raw.code === 'string' ? raw.code : '',
      );
      if (codeIndex === -1) throw new AppError(403, 'FORBIDDEN');
      const { nickname } = devCodeLoginSchema.parse(raw);
      const { userId, created } = await devSignIn(deps, nickname, { mode: 'beta' });
      const codeLabel = env.DEV_LOGIN_CODES[codeIndex]!.label;
      // Журнал — до сесії і без «тихого» logEvent: не вдалося записати — входу немає (500).
      await db.insert(events).values({
        type: 'auth.dev_login' satisfies EventType,
        userId,
        entityType: 'user',
        entityId: userId,
        payload: { codeLabel, codeIndex, created },
      });
      await startSession(req, res, userId);
      console.info(`[dev-login] code "${codeLabel}" -> user ${userId}${created ? ' (new)' : ''}`);
      res.json({ user: await getMe(deps, userId) });
    });
  }

  return router;
}
