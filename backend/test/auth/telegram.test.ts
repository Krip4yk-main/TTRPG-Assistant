import { describe, expect, it } from 'vitest';
import { verifyTelegramLogin } from '../../src/auth/providers/telegram.js';
import { sign, TEST_BOT_TOKEN as TOKEN } from './telegram-sign.js';

const NOW = 1_800_000_000;

const base = (authDate = NOW) => ({
  id: '42',
  first_name: 'Ada',
  username: 'ada',
  photo_url: 'https://t.me/i/u.jpg',
  auth_date: String(authDate),
});

describe('verifyTelegramLogin', () => {
  it('accepts valid signed data', () => {
    const r = verifyTelegramLogin(sign(base()), TOKEN, 86400, NOW);
    expect(r).toMatchObject({ provider: 'telegram', subject: '42', displayName: 'Ada' });
    expect(r.avatarUrl).toBe('https://t.me/i/u.jpg');
  });

  it('rejects a tampered first_name', () => {
    const d = sign(base());
    d.first_name = 'Eve';
    expect(() => verifyTelegramLogin(d, TOKEN, 86400, NOW)).toThrow(
      expect.objectContaining({ status: 401, code: 'TELEGRAM_AUTH_INVALID' }),
    );
  });

  it('rejects wrong token and missing/short hash', () => {
    expect(() => verifyTelegramLogin(sign(base(), 'other'), TOKEN, 86400, NOW)).toThrow();
    expect(() => verifyTelegramLogin({ ...base(), hash: 'abcd' }, TOKEN, 86400, NOW)).toThrow();
    expect(() => verifyTelegramLogin(base(), TOKEN, 86400, NOW)).toThrow();
  });

  it('auth_date boundary: now-86400 ok, now-86401 rejected', () => {
    expect(() => verifyTelegramLogin(sign(base(NOW - 86400)), TOKEN, 86400, NOW)).not.toThrow();
    expect(() => verifyTelegramLogin(sign(base(NOW - 86401)), TOKEN, 86400, NOW)).toThrow(
      expect.objectContaining({ code: 'TELEGRAM_AUTH_INVALID' }),
    );
  });

  it('rejects auth_date far in the future, allows small skew', () => {
    expect(() => verifyTelegramLogin(sign(base(NOW + 60)), TOKEN, 86400, NOW)).not.toThrow();
    expect(() => verifyTelegramLogin(sign(base(NOW + 61)), TOKEN, 86400, NOW)).toThrow();
  });

  it('rejects missing or non-numeric auth_date / empty id', () => {
    const noDate: Record<string, string> = base();
    delete noDate.auth_date;
    expect(() => verifyTelegramLogin(sign(noDate), TOKEN, 86400, NOW)).toThrow();
    expect(() => verifyTelegramLogin(sign({ ...base(), auth_date: 'x' }), TOKEN, 86400, NOW)).toThrow();
    expect(() => verifyTelegramLogin(sign({ ...base(), id: '' }), TOKEN, 86400, NOW)).toThrow();
  });
});
