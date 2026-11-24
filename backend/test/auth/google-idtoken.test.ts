import { describe, expect, it, vi } from 'vitest';

const claims: Record<string, unknown> = {};
vi.mock('arctic', () => ({
  Google: class {
    createAuthorizationURL() {
      return new URL('https://x');
    }
    validateAuthorizationCode() {
      return Promise.resolve({ idToken: () => 'tok' });
    }
  },
  decodeIdToken: () => claims,
}));

const { createGoogleProvider } = await import('../../src/auth/providers/google.js');
const p = createGoogleProvider({ clientId: 'cid', clientSecret: 's', publicBaseUrl: 'http://x' });
const set = (c: Record<string, unknown>) => {
  for (const k of Object.keys(claims)) delete claims[k];
  Object.assign(claims, c);
};

describe('google id_token validation', () => {
  it('accepts matching aud and iss', async () => {
    set({ sub: '1', aud: 'cid', iss: 'https://accounts.google.com', name: 'N', picture: 'u' });
    await expect(p.exchange('c', 'v')).resolves.toMatchObject({ subject: '1', displayName: 'N' });
    set({ sub: '1', aud: ['cid'], iss: 'accounts.google.com' });
    await expect(p.exchange('c', 'v')).resolves.toMatchObject({ subject: '1' });
  });
  it('rejects wrong aud or iss', async () => {
    set({ sub: '1', aud: 'other', iss: 'https://accounts.google.com' });
    await expect(p.exchange('c', 'v')).rejects.toThrow();
    set({ sub: '1', aud: 'cid', iss: 'https://evil.com' });
    await expect(p.exchange('c', 'v')).rejects.toThrow();
  });
});
