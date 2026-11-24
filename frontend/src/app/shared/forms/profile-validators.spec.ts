import { FormControl } from '@angular/forms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minAgeValidatorFor } from './profile-validators';

describe('minAgeValidatorFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T11:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const check = (tz: string | null) =>
    minAgeValidatorFor(() => tz)(new FormControl(new Date(2012, 10, 24)));

  it('uses the user time zone for "today" (already 24.11 in Kiritimati)', () => {
    expect(check('Pacific/Kiritimati')).toBeNull();
  });
  it('is too young in UTC (still 23.11)', () => {
    expect(check('UTC')).toEqual({ ageTooLow: true });
  });
  it('flags a date in the future in the user zone', () => {
    expect(minAgeValidatorFor(() => 'UTC')(new FormControl(new Date(2026, 10, 24)))).toEqual({
      futureDate: true,
    });
  });
  it('ignores empty values', () => {
    expect(minAgeValidatorFor(() => 'UTC')(new FormControl(null))).toBeNull();
  });
});
