import { describe, expect, it } from 'vitest';
import {
  criteriaForRole,
  GM_CRITERIA,
  PLAYER_CRITERIA,
  RATING_COMMENT_MAX,
  ratingInputSchema,
} from './ratings.js';

const ok = (v: unknown) => ratingInputSchema.safeParse(v).success;

describe('ratingInputSchema', () => {
  it('accepts a decline without overall', () => {
    expect(ratingInputSchema.parse({ rateeId: 'abcdefghij', declined: true })).toEqual({
      rateeId: 'abcdefghij',
      declined: true,
    });
    expect(ok({ rateeId: 'abcdefghij', sessionId: 3, declined: true })).toBe(true);
  });

  it('rejects a decline with scores or comment', () => {
    expect(ok({ rateeId: 'a', declined: true, overall: 4 })).toBe(false);
    expect(ok({ rateeId: 'a', declined: true, comment: 'x' })).toBe(false);
    expect(ok({ rateeId: 'a', declined: true, criteria: { safety: 5 } })).toBe(false);
    expect(ok({ rateeId: 'a', declined: false, overall: 4 })).toBe(false);
  });

  it('requires an integer overall in 1..5', () => {
    expect(ok({ rateeId: 'a' })).toBe(false);
    for (const overall of [0, 6, 2.5, '3']) expect(ok({ rateeId: 'a', overall })).toBe(false);
    for (const overall of [1, 5]) expect(ok({ rateeId: 'a', overall })).toBe(true);
  });

  it('accepts known criteria with 1..5 and rejects unknown keys or bad values', () => {
    expect(ok({ rateeId: 'a', overall: 4, criteria: { preparation: 5, respect: 1 } })).toBe(true);
    expect(ok({ rateeId: 'a', overall: 4, criteria: {} })).toBe(true);
    expect(ok({ rateeId: 'a', overall: 4, criteria: { charisma: 5 } })).toBe(false);
    expect(ok({ rateeId: 'a', overall: 4, criteria: { safety: 0 } })).toBe(false);
    expect(ok({ rateeId: 'a', overall: 4, criteria: { safety: 4.5 } })).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(ok({ rateeId: 'a', overall: 4, raterId: 1 })).toBe(false);
    expect(ok({ rateeId: 'a', declined: true, extra: 1 })).toBe(false);
  });

  it('trims comment, drops empty, limits to 2000 characters', () => {
    expect(ratingInputSchema.parse({ rateeId: 'a', overall: 3, comment: '  ок  ' })).toEqual({
      rateeId: 'a',
      overall: 3,
      comment: 'ок',
    });
    const empty = ratingInputSchema.parse({ rateeId: 'a', overall: 3, comment: '   ' });
    expect('comment' in empty && empty.comment).toBeFalsy();
    expect(ok({ rateeId: 'a', overall: 3, comment: 'ї'.repeat(RATING_COMMENT_MAX) })).toBe(true);
    expect(ok({ rateeId: 'a', overall: 3, comment: 'ї'.repeat(RATING_COMMENT_MAX + 1) })).toBe(
      false,
    );
  });

  it('validates rateeId and sessionId', () => {
    expect(ok({ rateeId: '', overall: 3 })).toBe(false);
    expect(ok({ rateeId: 5, overall: 3 })).toBe(false);
    expect(ok({ rateeId: 'a', sessionId: 0, overall: 3 })).toBe(false);
    expect(ok({ rateeId: 'a', sessionId: 1.5, overall: 3 })).toBe(false);
    expect(ok({ rateeId: 'a', sessionId: 7, overall: 3 })).toBe(true);
  });
});

describe('criteriaForRole', () => {
  it('maps gm to GM criteria and both player sources to player criteria', () => {
    expect(criteriaForRole('gm')).toBe(GM_CRITERIA);
    expect(criteriaForRole('player_from_gm')).toBe(PLAYER_CRITERIA);
    expect(criteriaForRole('player_from_player')).toBe(PLAYER_CRITERIA);
  });
});
