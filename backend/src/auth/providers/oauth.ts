import type { VerifiedIdentity } from './provider.js';

/** Параметри одного OAuth-потоку, що зберігаються в Redis-записі `oauth:<state>`. */
export interface OAuthFlowParams {
  state: string;
  /** PKCE code_verifier (у URL іде лише S256-challenge). */
  codeVerifier: string;
  /** OIDC nonce; провайдери без OIDC (Discord) можуть його ігнорувати. */
  nonce: string;
}

/**
 * Модульний OAuth2/OIDC-провайдер. Google — OIDC через `openid-client`
 * (discovery + перевірка ID Token). Discord (План 5) реалізує той самий інтерфейс,
 * але він не OIDC: там буде звичайний OAuth2-потік `openid-client`
 * (`authorizationCodeGrant` без `idTokenExpected`) + запит до userinfo-ендпоінта.
 */
export interface OAuthProvider {
  id: 'google' | 'discord';
  /** Може звертатися до мережі (lazy discovery) — тому async. */
  createAuthorizationUrl(params: OAuthFlowParams): Promise<URL>;
  /** `callbackParams` — query-параметри callback-запиту (code, state, iss, ...). */
  exchange(
    params: OAuthFlowParams & { callbackParams: URLSearchParams },
  ): Promise<VerifiedIdentity>;
}
