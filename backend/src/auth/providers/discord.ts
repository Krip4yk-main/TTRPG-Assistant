import { createHash } from 'node:crypto';
import type { OAuthProvider } from './oauth.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';
const PROVIDER_TIMEOUT_MS = 10_000;

/** Snowflake-id користувача Discord. */
const SNOWFLAKE = /^\d{1,20}$/;
/** Хеш аватара (анімований — з префіксом `a_`). */
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;

class DiscordOAuthError extends Error {
  override name = 'DiscordOAuthError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Discord — звичайний OAuth 2.0 (не OIDC): authorization code + PKCE S256, scope `identify`.
 * Код обмінюємо на токен (`POST /api/oauth2/token`, client_secret_basic), потім читаємо
 * `GET /api/users/@me`; subject — Discord id. Токен ніде не зберігається. Запити — `fetch`
 * з таймаутом, без редиректів. `state` додатково звіряє маршрут (Redis + кука).
 */
export function createDiscordProvider(opts: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  /** Лише для тестів: підміна мережі. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}): OAuthProvider {
  const redirectUri = `${opts.publicBaseUrl.replace(/\/+$/, '')}/api/auth/discord/callback`;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  // RFC 6749 §2.3.1: id і секрет у Basic кодуються як form-urlencoded.
  const basic = Buffer.from(
    `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`,
  ).toString('base64');

  const getJson = async (url: string, init: RequestInit, what: string): Promise<unknown> => {
    const res = await doFetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Тіло відповіді в помилку не кладемо (може містити чутливі дані).
    if (!res.ok) throw new DiscordOAuthError(`${what} failed`, `HTTP_${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new DiscordOAuthError(`${what}: invalid JSON`, 'INVALID_RESPONSE');
    }
  };

  return {
    id: 'discord',
    createAuthorizationUrl: async ({ state, codeVerifier }) => {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId,
        scope: 'identify',
        redirect_uri: redirectUri,
        state,
        code_challenge: pkceChallenge(codeVerifier),
        code_challenge_method: 'S256',
      }).toString();
      return url;
    },
    exchange: async ({ callbackParams, codeVerifier, state }) => {
      if (callbackParams.get('state') !== state) {
        throw new DiscordOAuthError('state mismatch', 'STATE_MISMATCH');
      }
      const code = callbackParams.get('code');
      if (!code) throw new DiscordOAuthError('missing code', 'MISSING_CODE');

      const token = (await getJson(
        TOKEN_URL,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${basic}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }).toString(),
        },
        'token exchange',
      )) as Record<string, unknown> | null;
      const accessToken = str(token?.access_token);
      if (!accessToken || str(token?.token_type)?.toLowerCase() !== 'bearer') {
        throw new DiscordOAuthError('token response without bearer token', 'INVALID_RESPONSE');
      }

      const me = (await getJson(
        ME_URL,
        { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
        'users/@me',
      )) as Record<string, unknown> | null;
      const id = str(me?.id);
      if (!id || !SNOWFLAKE.test(id)) {
        throw new DiscordOAuthError('users/@me without id', 'INVALID_RESPONSE');
      }
      const avatar = str(me?.avatar);
      return {
        provider: 'discord',
        subject: id,
        displayName: str(me?.global_name) ?? str(me?.username),
        avatarUrl:
          avatar && AVATAR_HASH.test(avatar)
            ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
            : undefined,
      };
    },
  };
}
