import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'Invalid calendar date');

const ianaTimezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA timezone');

export const completeProfileSchema = z.object({
  nickname: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[\p{L}\p{N}_.-]+$/u),
  birthDate: isoDate,
  timezone: ianaTimezone.optional(),
});
export type CompleteProfileInput = z.infer<typeof completeProfileSchema>;

export const devLoginSchema = z.object({
  nickname: z.string().min(1),
  ownerKey: z.string().optional(),
});
export type DevLoginInput = z.infer<typeof devLoginSchema>;
