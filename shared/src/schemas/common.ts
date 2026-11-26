import { z } from 'zod';
import { BLOCKED_TIMEZONES, normalizeTimezone } from '../timezones.js';

/** Календарна дата `YYYY-MM-DD`, що реально існує. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Invalid calendar date');

/**
 * Пояс IANA, відомий `Intl`, який можна обрати: `Europe/Kiev` зберігається як `Europe/Kyiv`,
 * пояси за містами Росії відхиляються (див. timezones.ts).
 */
export const ianaTimezone = z
  .string()
  .transform(normalizeTimezone)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone')
  .refine((tz) => !BLOCKED_TIMEZONES.has(tz), 'Timezone not allowed');
