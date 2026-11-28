import { describe, expect, it } from 'vitest';
import { completeProfileSchema, devCodeLoginSchema, devLoginSchema } from './auth.js';

describe('completeProfileSchema', () => {
  const ok = { nickname: 'Майстер_Ігор', birthDate: '2000-01-01' };
  it('accepts a valid profile', () =>
    expect(completeProfileSchema.safeParse(ok).success).toBe(true));
  it('rejects short nickname', () =>
    expect(completeProfileSchema.safeParse({ ...ok, nickname: 'ab' }).success).toBe(false));
  it('rejects nickname with space', () =>
    expect(completeProfileSchema.safeParse({ ...ok, nickname: 'a b c' }).success).toBe(false));
  it('rejects invalid date', () =>
    expect(completeProfileSchema.safeParse({ ...ok, birthDate: '2026-13-01' }).success).toBe(
      false,
    ));
  it('accepts IANA timezone', () =>
    expect(completeProfileSchema.safeParse({ ...ok, timezone: 'Europe/Kyiv' }).success).toBe(true));
});

describe('devLoginSchema', () => {
  it('accepts nickname with optional ownerKey', () => {
    expect(devLoginSchema.safeParse({ nickname: 'x' }).success).toBe(true);
    expect(devLoginSchema.safeParse({ nickname: 'x', ownerKey: 'k' }).success).toBe(true);
  });
});

describe('devCodeLoginSchema', () => {
  it('requires code and nickname, has no ownerKey', () => {
    expect(devCodeLoginSchema.safeParse({ code: 'c', nickname: 'x' }).success).toBe(true);
    expect(devCodeLoginSchema.safeParse({ nickname: 'x' }).success).toBe(false);
    expect(devCodeLoginSchema.safeParse({ code: 'c', nickname: 'x'.repeat(33) }).success).toBe(
      false,
    );
    const parsed = devCodeLoginSchema.parse({ code: 'c', nickname: 'x', ownerKey: 'k' });
    expect(parsed).not.toHaveProperty('ownerKey');
  });
});
