import { convertToParamMap } from '@angular/router';
import {
  EMPTY_FILTERS,
  MAX_RANGE_DAYS,
  dateRangeError,
  parseSearchParams,
  resolveCalendarMode,
  toSearchParams,
  toSearchRequest,
} from './search-query';

const parse = (p: Record<string, string | string[]>) => parseSearchParams(convertToParamMap(p));

describe('search-query', () => {
  describe('parseSearchParams', () => {
    it('returns defaults for an empty URL', () => {
      expect(parse({})).toEqual({
        ...EMPTY_FILTERS,
        format: undefined,
        city: undefined,
        kind: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        priceMax: undefined,
        experience: undefined,
        platform: undefined,
        language: undefined,
        calendar: undefined,
      });
    });

    it('drops garbage values silently', () => {
      const f = parse({
        systems: '1,abc,-2,0,3.5,4',
        genres: 'x',
        format: 'telepathy',
        kind: '1',
        price: 'cheap',
        priceMax: '-5',
        age: '18+,99+,none',
        exp: 'god',
        lang: 'klingon',
        free: 'yes',
        noWarn: '2,,2',
        cal: 'custom',
        partial: 'true',
        sort: 'random',
        city: '   ',
      });
      expect(f.systemIds).toEqual([1, 4]);
      expect(f.genreIds).toEqual([]);
      expect(f.format).toBeUndefined();
      expect(f.kind).toBeUndefined();
      expect(f.priceMode).toBe('any');
      expect(f.priceMax).toBeUndefined();
      expect(f.ageRatings).toEqual(['18+', 'none']);
      expect(f.experience).toBeUndefined();
      expect(f.language).toBeUndefined();
      expect(f.hasFreeSlots).toBe(false);
      expect(f.excludeWarningIds).toEqual([2]);
      expect(f.calendar).toBeUndefined();
      expect(f.includePartial).toBe(false);
      expect(f.sort).toBe('soonest');
      expect(f.city).toBeUndefined();
    });

    it('treats an empty or non-integer priceMax as not set', () => {
      expect(parse({ priceMax: '' }).priceMax).toBeUndefined();
      expect(parse({ priceMax: '12.5' }).priceMax).toBeUndefined();
      expect(parse({ priceMax: '100001' }).priceMax).toBeUndefined();
      expect(parse({ priceMax: '0' }).priceMax).toBe(0);
      expect(parse({ priceMax: '250' }).priceMax).toBe(250);
    });

    it('uses the first value of repeated (array) params without crashing', () => {
      const f = parse({ format: ['online', 'offline'], systems: ['1,2', '3'], sort: ['x', 'new'] });
      expect(f.format).toBe('online');
      expect(f.systemIds).toEqual([1, 2]);
      expect(f.sort).toBe('soonest');
    });

    it('rejects malformed and rolled-over dates', () => {
      expect(parse({ from: '2027-02-30' }).dateFrom).toBeUndefined();
      expect(parse({ from: '2027-02-29' }).dateFrom).toBeUndefined();
      expect(parse({ from: '2028-02-29' }).dateFrom).toBe('2028-02-29');
      expect(parse({ from: '2027-13-01' }).dateFrom).toBeUndefined();
      expect(parse({ to: '2027-4-1' }).dateTo).toBeUndefined();
      expect(parse({ to: 'tomorrow' }).dateTo).toBeUndefined();
      expect(parse({ to: '2027-04-31' }).dateTo).toBeUndefined();
      expect(parse({ to: '2027-04-30' }).dateTo).toBe('2027-04-30');
    });

    it('round-trips through toSearchParams', () => {
      const f = parse({ systems: '2,5', format: 'online', price: 'paid', priceMax: '300' });
      const params = Object.fromEntries(
        Object.entries(toSearchParams(f))
          .filter(([, v]) => v !== null)
          .map(([k, v]) => [k, String(v)]),
      ) as Record<string, string>;
      expect(parse(params)).toEqual(f);
    });
  });

  describe('date window', () => {
    const range = (dateFrom: string, dateTo: string) => ({ ...EMPTY_FILTERS, dateFrom, dateTo });

    it('allows exactly MAX_RANGE_DAYS (365) days inclusive', () => {
      expect(MAX_RANGE_DAYS).toBe(365);
      expect(dateRangeError(range('2027-01-01', '2027-12-31'))).toBeNull();
    });

    it('rejects a longer window and a reversed range', () => {
      expect(dateRangeError(range('2027-01-01', '2028-01-01'))).toBe('window');
      expect(dateRangeError(range('2027-01-02', '2027-01-01'))).toBe('order');
    });

    it('does not send an invalid range; sends an inclusive valid one', () => {
      const bad = toSearchRequest(range('2027-01-01', '2028-01-01'), { mode: 'off' }, 'UTC');
      expect(bad.dateFrom).toBeUndefined();
      expect(bad.dateTo).toBeUndefined();
      const ok = toSearchRequest(range('2027-03-01', '2027-03-02'), { mode: 'off' }, 'UTC');
      expect(ok.dateFrom).toBe('2027-03-01T00:00:00.000Z');
      expect(ok.dateTo).toBe('2027-03-03T00:00:00.000Z');
    });
  });

  describe('resolveCalendarMode', () => {
    it('a guest is always off, even with cal=mine', () => {
      const chosen = parse({ cal: 'mine' }).calendar;
      expect(chosen).toBe('mine');
      expect(resolveCalendarMode({ signedIn: false, custom: false, chosen, hasSlots: true })).toBe(
        'off',
      );
    });

    it('signed in: custom wins, then cal=off, then the saved slots decide', () => {
      expect(
        resolveCalendarMode({ signedIn: true, custom: true, chosen: 'off', hasSlots: false }),
      ).toBe('custom');
      expect(
        resolveCalendarMode({ signedIn: true, custom: false, chosen: 'off', hasSlots: true }),
      ).toBe('off');
      expect(
        resolveCalendarMode({ signedIn: true, custom: false, chosen: undefined, hasSlots: null }),
      ).toBeNull();
      expect(
        resolveCalendarMode({ signedIn: true, custom: false, chosen: 'mine', hasSlots: false }),
      ).toBe('off');
      expect(
        resolveCalendarMode({ signedIn: true, custom: false, chosen: undefined, hasSlots: true }),
      ).toBe('mine');
    });
  });
});
