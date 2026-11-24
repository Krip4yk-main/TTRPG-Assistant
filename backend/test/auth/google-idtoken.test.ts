import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGoogleProvider } from '../../src/auth/providers/google.js';

/*
 * Справжній `openid-client` проти локального «фейкового Google»: мережевий шар
 * підмінено через `customFetch` (discovery, JWKS, token endpoint), тож бібліотека
 * сама перевіряє підпис ID Token (JWKS), iss, aud, exp, nonce, state і PKCE.
 * Реальної мережі немає — будь-який інший URL у тесті кидає помилку.
 */
const ISSUER = 'https://accounts.google.com';
const CLIENT_ID = 'cid.apps.googleusercontent.com';
const BASE = 'https://nri.example';
const REDIRECT = `${BASE}/api/auth/google/callback`;

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'k1';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function jwt(claims: Record<string, unknown>, privateKey: KeyObject = key.privateKey): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const body = b64u(JSON.stringify(claims));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

let idToken = '';
let discoveryCalls = 0;
let discoveryFails = 0;
let tokenBody: URLSearchParams | null = null;

const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const u = new URL(url);
  if (u.href === `${ISSUER}/.well-known/openid-configuration`) {
    discoveryCalls++;
    if (discoveryFails > 0) {
      discoveryFails--;
      return json({ error: 'unavailable' }, 503);
    }
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (u.href === 'https://www.googleapis.com/oauth2/v3/certs') {
    const jwk = key.publicKey.export({ format: 'jwk' });
    return json({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  }
  if (u.href === 'https://oauth2.googleapis.com/token') {
    tokenBody = new URLSearchParams(String(init?.body));
    return json({
      access_token: 'at',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile',
      ...(idToken ? { id_token: idToken } : {}),
    });
  }
  throw new Error(`unexpected network call in test: ${url}`);
};

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT_ID,
  sub: '1234',
  name: 'Gina',
  picture: 'https://img/g.png',
  nonce: 'n-1',
  iat: now(),
  exp: now() + 300,
  ...over,
});

const mk = () =>
  createGoogleProvider({
    clientId: CLIENT_ID,
    clientSecret: 'secret',
    publicBaseUrl: `${BASE}/`,
    customFetch: fakeFetch,
  });

const cb = (q: Record<string, string>) => new URLSearchParams(q);
const flow = { codeVerifier: 'v'.repeat(43), state: 's-1', nonce: 'n-1' };

beforeEach(() => {
  idToken = jwt(goodClaims());
  discoveryCalls = 0;
  discoveryFails = 0;
  tokenBody = null;
});

describe('google provider (openid-client)', () => {
  it('builds an authorization URL with scope, state, nonce and S256 PKCE', async () => {
    const url = await mk().createAuthorizationUrl(flow);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/o/oauth2/v2/auth`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('scope')).toBe('openid profile');
    expect(q.get('state')).toBe('s-1');
    expect(q.get('nonce')).toBe('n-1');
    expect(q.get('code_challenge_method')).toBe('S256');
    const expected = createHash('sha256').update(flow.codeVerifier).digest('base64url');
    expect(q.get('code_challenge')).toBe(expected);
  });

  it('exchanges the code and returns identity from validated claims', async () => {
    const id = await mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) });
    expect(id).toEqual({
      provider: 'google',
      subject: '1234',
      displayName: 'Gina',
      avatarUrl: 'https://img/g.png',
    });
    expect(tokenBody?.get('code')).toBe('c');
    expect(tokenBody?.get('code_verifier')).toBe(flow.codeVerifier);
    expect(tokenBody?.get('redirect_uri')).toBe(REDIRECT);
  });

  it.each([
    ['wrong aud', { aud: 'someone-else' }],
    ['wrong iss', { iss: 'https://evil.example' }],
    ['wrong nonce', { nonce: 'n-other' }],
    ['expired', { iat: now() - 7200, exp: now() - 3600 }],
    ['missing sub', { sub: undefined }],
  ])('rejects an ID Token with %s', async (_name, over) => {
    idToken = jwt(goodClaims(over));
    await expect(
      mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) }),
    ).rejects.toThrow();
  });

  it('rejects an ID Token signed by a key not in the JWKS', async () => {
    idToken = jwt(goodClaims(), otherKey.privateKey);
    await expect(
      mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) }),
    ).rejects.toThrow();
  });

  it('rejects a token response without an id_token', async () => {
    idToken = '';
    await expect(
      mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) }),
    ).rejects.toThrow();
  });

  it.each(['HS256', 'none'])('rejects an ID Token with alg %s', async (alg) => {
    const head = b64u(JSON.stringify({ alg, typ: 'JWT', kid: KID }));
    const body = b64u(JSON.stringify(goodClaims()));
    // HS256 підписано client secret — класична атака «alg confusion».
    const sig =
      alg === 'none' ? '' : b64u(createHmac('sha256', 'secret').update(`${head}.${body}`).digest());
    idToken = `${head}.${body}.${sig}`;
    await expect(
      mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) }),
    ).rejects.toThrow();
  });

  it('rejects a callback whose state does not match the expected one', async () => {
    await expect(
      mk().exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-forged' }) }),
    ).rejects.toThrow();
    expect(tokenBody).toBeNull();
  });

  it('discovery failure rejects, is retried next time, then cached', async () => {
    const p = mk();
    discoveryFails = 1;
    await expect(p.createAuthorizationUrl(flow)).rejects.toThrow();
    await expect(p.createAuthorizationUrl(flow)).resolves.toBeInstanceOf(URL);
    await p.createAuthorizationUrl(flow);
    await p.exchange({ ...flow, callbackParams: cb({ code: 'c', state: 's-1' }) });
    expect(discoveryCalls).toBe(2);
  });
});
