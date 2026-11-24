import { decodeIdToken, Google } from 'arctic';
import type { OAuthProvider } from './oauth.js';

type IdClaims = { sub?: unknown; name?: unknown; picture?: unknown; aud?: unknown; iss?: unknown };
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function createGoogleProvider(opts: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
}): OAuthProvider {
  const redirectUri = `${opts.publicBaseUrl.replace(/\/+$/, '')}/api/auth/google/callback`;
  const google = new Google(opts.clientId, opts.clientSecret, redirectUri);
  return {
    id: 'google',
    createAuthorizationUrl: (state, codeVerifier) =>
      google.createAuthorizationURL(state, codeVerifier, ['openid', 'profile']),
    exchange: async (code, codeVerifier) => {
      const tokens = await google.validateAuthorizationCode(code, codeVerifier);
      const claims = decodeIdToken(tokens.idToken()) as IdClaims;
      const aud = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud];
      if (!aud.includes(opts.clientId)) throw new Error('id_token aud mismatch');
      if (typeof claims.iss !== 'string' || !ISSUERS.includes(claims.iss)) {
        throw new Error('id_token iss mismatch');
      }
      if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token without sub');
      return {
        provider: 'google',
        subject: claims.sub,
        displayName: typeof claims.name === 'string' ? claims.name : undefined,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
      };
    },
  };
}
