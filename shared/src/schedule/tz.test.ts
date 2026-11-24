import { describe, expect, it } from 'vitest';
import { toZoned, zonedToUtc } from './tz.js';

const z = (year: number, month: number, day: number, hour: number, minute: number) => ({
  year,
  month,
  day,
  hour,
  minute,
});

describe('zonedToUtc', () => {
  it('converts regular local times', () => {
    expect(zonedToUtc(z(2026, 12, 1, 19, 0), 'Europe/Kyiv').toISOString()).toBe(
      '2026-12-01T17:00:00.000Z',
    );
    expect(zonedToUtc(z(2027, 7, 1, 19, 0), 'Europe/Kyiv').toISOString()).toBe(
      '2027-07-01T16:00:00.000Z',
    );
  });
  it('shifts forward inside a DST gap', () => {
    // Kyiv 2027-03-28 03:00 -> 04:00; 03:30 не існує -> 04:30 EEST.
    expect(zonedToUtc(z(2027, 3, 28, 3, 30), 'Europe/Kyiv').toISOString()).toBe(
      '2027-03-28T01:30:00.000Z',
    );
  });
  it('picks the earlier instant inside a DST overlap', () => {
    // Kyiv 2027-10-31 04:00 -> 03:00; 03:30 буває двічі: 00:30Z і 01:30Z.
    expect(zonedToUtc(z(2027, 10, 31, 3, 30), 'Europe/Kyiv').toISOString()).toBe(
      '2027-10-31T00:30:00.000Z',
    );
  });
});

describe('toZoned', () => {
  it('returns local parts with Monday = 0', () => {
    expect(toZoned(new Date('2026-12-01T22:30:00Z'), 'Europe/Kyiv')).toEqual({
      year: 2026,
      month: 12,
      day: 2,
      hour: 0,
      minute: 30,
      weekday: 2,
    });
  });
});
