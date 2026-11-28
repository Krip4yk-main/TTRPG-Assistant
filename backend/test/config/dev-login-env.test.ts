import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { TEST_PEPPER } from '../helpers.js';

// Фейкові коди лише для тестів (≥ 24 символів).
const CODE_A = 'test-code-aaaaaaaaaaaaaaaaaaaa';
const CODE_B = 'test-code-bbbbbbbbbbbbbbbbbbbb';

const base = {
  DATABASE_URL: 'a',
  REDIS_URL: 'b',
  IDENTITY_PEPPER: TEST_PEPPER,
  INTERNAL_API_KEY: 'test-internal-key-0123456789abcdefghij',
};
const deployed = (DEPLOY_ENV: 'dev' | 'prod') => ({
  ...base,
  DEPLOY_ENV,
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://dev.nri.example.com',
});

/** Текст помилки старту (і перевірка, що в ньому немає значень кодів). */
function startupError(source: Record<string, string | undefined>): string {
  try {
    loadEnv(source);
  } catch (err) {
    const msg = (err as Error).message;
    for (const v of Object.values(source)) if (v && v.length >= 24) expect(msg).not.toContain(v);
    return msg;
  }
  throw new Error('expected loadEnv to throw');
}

describe('DEV_LOGIN_CODES', () => {
  it('defaults to an empty list', () => {
    expect(loadEnv(base).DEV_LOGIN_CODES).toEqual([]);
  });

  it('parses label:code and bare codes (label = #position), trimming spaces', () => {
    const env = loadEnv({ ...base, DEV_LOGIN_CODES: ` alice:${CODE_A} , ${CODE_B} ` });
    expect(env.DEV_LOGIN_CODES).toEqual([
      { label: 'alice', code: CODE_A },
      { label: '#2', code: CODE_B },
    ]);
  });

  it('refuses to start on a code shorter than 24 characters', () => {
    expect(startupError({ ...base, DEV_LOGIN_CODES: 'bob:short-code' })).toMatch(
      /DEV_LOGIN_CODES \(each code must be at least 24 characters/,
    );
    expect(startupError({ ...base, DEV_LOGIN_CODES: `${CODE_A},${'x'.repeat(23)}` })).toMatch(
      /DEV_LOGIN_CODES/,
    );
  });

  it('refuses low-entropy codes (fewer than 8 distinct characters)', () => {
    for (const code of ['a'.repeat(24), 'abcdefg'.repeat(4)]) {
      expect(startupError({ ...base, DEV_LOGIN_CODES: `bob:${code}` })).toMatch(
        /DEV_LOGIN_CODES \(each code must have at least 8 distinct characters/,
      );
    }
    expect(
      loadEnv({ ...base, DEV_LOGIN_CODES: `bob:${'abcdefgh'.repeat(3)}` }).DEV_LOGIN_CODES,
    ).toHaveLength(1);
  });

  it('refuses empty entries, empty/invalid labels and duplicates', () => {
    for (const DEV_LOGIN_CODES of [
      `${CODE_A},,${CODE_B}`,
      `:${CODE_A}`,
      `bad label:${CODE_A}`,
      `${CODE_A},${CODE_A}`,
      `a:${CODE_A},a:${CODE_B}`,
    ]) {
      expect(startupError({ ...base, DEV_LOGIN_CODES })).toMatch(/DEV_LOGIN_CODES \(/);
    }
  });
});

describe('dev login per DEPLOY_ENV', () => {
  it('prod refuses to start with any dev-login setting', () => {
    for (const extra of [
      { DEV_LOGIN_ENABLED: 'true' },
      { DEV_LOGIN_CODES: `a:${CODE_A}` },
      { DEV_OWNER_KEY: 'some-owner-key' },
    ]) {
      const key = Object.keys(extra)[0]!;
      expect(startupError({ ...deployed('prod'), ...extra })).toMatch(
        new RegExp(`${key} \\(must not be set when DEPLOY_ENV=prod\\)`),
      );
    }
  });

  it('prod starts with dev login explicitly off or unset (empty = unset)', () => {
    expect(loadEnv({ ...deployed('prod'), DEV_LOGIN_ENABLED: 'false' }).DEV_LOGIN_ENABLED).toBe(
      false,
    );
    expect(
      loadEnv({ ...deployed('prod'), DEV_LOGIN_CODES: '', DEV_OWNER_KEY: '' }).DEV_LOGIN_CODES,
    ).toEqual([]);
  });

  it('dev (beta) with DEV_LOGIN_ENABLED=true requires at least one code', () => {
    expect(startupError({ ...deployed('dev'), DEV_LOGIN_ENABLED: 'true' })).toMatch(
      /DEV_LOGIN_CODES \(required when DEV_LOGIN_ENABLED=true on DEPLOY_ENV=dev\)/,
    );
    const env = loadEnv({
      ...deployed('dev'),
      DEV_LOGIN_ENABLED: 'true',
      DEV_LOGIN_CODES: `t1:${CODE_A}`,
    });
    expect(env.DEV_LOGIN_CODES).toHaveLength(1);
  });
});
