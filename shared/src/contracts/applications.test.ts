import { describe, expect, it } from 'vitest';
import {
  APPLICATION_CONSTRAINTS_MAX,
  applicationInputSchema,
  constraintResponseInputSchema,
} from './applications.js';

const base = { warningsAccepted: true, answers: [] };

describe('applicationInputSchema', () => {
  it('trims and defaults optional fields', () => {
    const r = applicationInputSchema.parse({ warningsAccepted: true, answers: [' так '] });
    expect(r).toEqual({ warningsAccepted: true, answers: ['так'], message: null, constraints: [] });
  });
  it('turns an empty message into null', () => {
    expect(applicationInputSchema.parse({ ...base, message: '  ' }).message).toBeNull();
  });
  it('limits the message to 1000 characters', () => {
    expect(applicationInputSchema.safeParse({ ...base, message: 'a'.repeat(1000) }).success).toBe(
      true,
    );
    expect(applicationInputSchema.safeParse({ ...base, message: 'a'.repeat(1001) }).success).toBe(
      false,
    );
  });
  it('limits constraints to 10 non-empty items of at most 200 characters', () => {
    const ok = Array.from({ length: APPLICATION_CONSTRAINTS_MAX }, () => 'x'.repeat(200));
    expect(APPLICATION_CONSTRAINTS_MAX).toBe(10);
    expect(applicationInputSchema.safeParse({ ...base, constraints: ok }).success).toBe(true);
    expect(applicationInputSchema.safeParse({ ...base, constraints: [...ok, 'x'] }).success).toBe(
      false,
    );
    expect(
      applicationInputSchema.safeParse({ ...base, constraints: ['x'.repeat(201)] }).success,
    ).toBe(false);
    expect(applicationInputSchema.safeParse({ ...base, constraints: [' '] }).success).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(applicationInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe('constraintResponseInputSchema', () => {
  it('accepts accepted / cannot_guarantee without a comment', () => {
    expect(constraintResponseInputSchema.parse({ response: 'accepted' })).toEqual({
      response: 'accepted',
      comment: null,
    });
    expect(constraintResponseInputSchema.safeParse({ response: 'cannot_guarantee' }).success).toBe(
      true,
    );
  });
  it('requires a comment for partial', () => {
    expect(constraintResponseInputSchema.safeParse({ response: 'partial' }).success).toBe(false);
    expect(
      constraintResponseInputSchema.safeParse({ response: 'partial', comment: '  ' }).success,
    ).toBe(false);
    expect(
      constraintResponseInputSchema.safeParse({ response: 'partial', comment: 'лише онлайн' })
        .success,
    ).toBe(true);
  });
  it('limits the comment to 500 characters', () => {
    expect(
      constraintResponseInputSchema.safeParse({ response: 'partial', comment: 'a'.repeat(501) })
        .success,
    ).toBe(false);
  });
});
