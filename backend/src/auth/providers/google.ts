import * as oidc from 'openid-client';
import type { OAuthProvider } from './oauth.js';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

export function createGoogleProvider(opts: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  /** Лише для тестів: підміна мережевого шару `openid-client`. */
  customFetch?: oidc.CustomFetch;
}): OAuthProvider {
  const redirectUri = `${opts.publicBaseUrl.replace(/\/+$/, '')}/api/auth/google/callback`;

  // Lazy discovery: кешуємо лише успіх; невдача (мережа/5xx) прокидається
  // викликачеві й наступний виклик пробує знову.
  let config: Promise<oidc.Configuration> | null = null;
  const getConfig = (): Promise<oidc.Configuration> => {
    config ??= oidc
      .discovery(GOOGLE_ISSUER, opts.clientId, opts.clientSecret, undefined, {
        // Перевірка підпису ID Token через JWKS (за замовчуванням oauth4webapi
        // для токенів із token endpoint покладається лише на TLS).
        execute: [oidc.enableNonRepudiationChecks],
        ...(opts.customFetch ? { [oidc.customFetch]: opts.customFetch } : {}),
      })
      .catch((err: unknown) => {
        config = null;
        throw err;
      });
    return config;
  };

  return {
    id: 'google',
    createAuthorizationUrl: async ({ state, codeVerifier, nonce }) => {
      const cfg = await getConfig();
      return oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri,
        scope: 'openid profile',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      });
    },
    exchange: async ({ callbackParams, codeVerifier, state, nonce }) => {
      const cfg = await getConfig();
      const currentUrl = new URL(redirectUri);
      currentUrl.search = callbackParams.toString();
      // Бібліотека перевіряє state, PKCE, підпис ID Token (JWKS), iss, aud, exp/iat, nonce.
      const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
        throw new Error('id_token without sub');
      }
      return {
        provider: 'google',
        subject: claims.sub,
        displayName: typeof claims.name === 'string' ? claims.name : undefined,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
      };
    },
  };
}
