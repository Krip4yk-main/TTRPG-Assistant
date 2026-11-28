import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { TEST_PEPPER } from '../helpers.js';

const base = {
  DATABASE_URL: 'a',
  REDIS_URL: 'b',
  IDENTITY_PEPPER: TEST_PEPPER,
  INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
};

describe('OWNER_TELEGRAM_ID', () => {
  it('is optional (empty = not set) and kept as a numeric string', () => {
    expect(loadEnv(base).OWNER_TELEGRAM_ID).toBeUndefined();
    expect(loadEnv({ ...base, OWNER_TELEGRAM_ID: '' }).OWNER_TELEGRAM_ID).toBeUndefined();
    expect(loadEnv({ ...base, OWNER_TELEGRAM_ID: '123456789' }).OWNER_TELEGRAM_ID).toBe(
      '123456789',
    );
  });

  it.each(['abc', '12 34', '-5', '0', '0123', '1.5', '@user', '1'.repeat(21)])(
    'rejects %s at startup',
    (v) => {
      expect(() => loadEnv({ ...base, OWNER_TELEGRAM_ID: v })).toThrow(/OWNER_TELEGRAM_ID/);
    },
  );
});
