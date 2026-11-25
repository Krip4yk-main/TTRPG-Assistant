import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  BACKEND_INTERNAL_URL: 'http://backend:3000',
  INTERNAL_API_KEY: 'k'.repeat(32),
};

describe('loadEnv', () => {
  it('defaults PUBLIC_BASE_URL to localhost outside production', () => {
    expect(loadEnv(base).PUBLIC_BASE_URL).toBe('http://localhost:4200');
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).PUBLIC_BASE_URL).toBe('http://localhost:4200');
  });

  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/PUBLIC_BASE_URL/);
    expect(
      loadEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://nri.example' })
        .PUBLIC_BASE_URL,
    ).toBe('https://nri.example');
  });

  it('names missing variables without printing values', () => {
    let msg = '';
    try {
      loadEnv({ ...base, INTERNAL_API_KEY: 'short-secret' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('INTERNAL_API_KEY');
    expect(msg).not.toContain('short-secret');
  });
});
