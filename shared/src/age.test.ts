import { describe, expect, it } from 'vitest';
import { ageOn, canRegister, meetsAgeRating } from './age.js';

describe('age rules', () => {
  it('exactly 14 today is allowed', () =>
    expect(canRegister('2012-11-24', '2026-11-24')).toBe(true));
  it('one day short of 14 is refused', () =>
    expect(canRegister('2012-11-25', '2026-11-24')).toBe(false));
  it('leap-day birthday counts on Feb 28 in non-leap year', () =>
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(18));
  it('guest sees only unrated games', () => {
    expect(meetsAgeRating(null, 'none')).toBe(true);
    expect(meetsAgeRating(null, '16+')).toBe(false);
    expect(meetsAgeRating(null, '18+')).toBe(false);
  });
  it('16+: 15-year-old no, 16-year-old yes (birthday edge)', () => {
    expect(meetsAgeRating(ageOn('2010-11-27', '2026-11-26'), '16+')).toBe(false);
    expect(meetsAgeRating(ageOn('2010-11-26', '2026-11-26'), '16+')).toBe(true);
    expect(meetsAgeRating(16, '18+')).toBe(false);
  });
  it('20-year-old: 18+ yes, 21+ no', () => {
    expect(meetsAgeRating(20, '18+')).toBe(true);
    expect(meetsAgeRating(20, '21+')).toBe(false);
  });
});
