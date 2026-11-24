import { describe, expect, it } from 'vitest';
import { leaveGameInputSchema, MEMBER_LEFT_REASONS } from './members.js';

const NOTE = 'Переїжджаю в інше місто';

describe('leaveGameInputSchema', () => {
  it('requires at least 10 characters for the GM', () => {
    expect(leaveGameInputSchema.safeParse({ noteForGm: 'коротко' }).success).toBe(false);
    expect(leaveGameInputSchema.safeParse({ noteForGm: '   123456789   ' }).success).toBe(false);
  });
  it('copies the GM note to the admin note when the latter is empty', () => {
    expect(leaveGameInputSchema.parse({ noteForGm: NOTE })).toEqual({
      noteForGm: NOTE,
      noteForAdmin: NOTE,
    });
    expect(leaveGameInputSchema.parse({ noteForGm: NOTE, noteForAdmin: ' ' }).noteForAdmin).toBe(
      NOTE,
    );
  });
  it('keeps an explicit admin note', () => {
    expect(
      leaveGameInputSchema.parse({ noteForGm: NOTE, noteForAdmin: 'Грубість' }).noteForAdmin,
    ).toBe('Грубість');
  });
});

describe('MEMBER_LEFT_REASONS', () => {
  it('includes account deletion', () => {
    expect(MEMBER_LEFT_REASONS).toEqual(['left', 'kicked', 'banned', 'account_deleted']);
  });
});
