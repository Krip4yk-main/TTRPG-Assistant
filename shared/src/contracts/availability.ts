import { z } from 'zod';
import type { Weekday } from '../schedule/tz.js';
import { ianaTimezone, isoDate } from '../schemas/common.js';

/**
 * Тижнева доступність гравця: вільні інтервали (кроком 30 хв) і разові зайняті дати.
 * Зберігається в поясі гравця.
 */
export interface AvailabilityDto {
  timezone: string;
  /** `0 ≤ startMin < endMin ≤ 1440`, кратні 30. */
  slots: { weekday: Weekday; startMin: number; endMin: number }[];
  /** `YYYY-MM-DD` у поясі гравця. */
  busyDates: string[];
}

const minuteOfDay = z.number().int().min(0).max(1440).multipleOf(30);

const slotSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMin: minuteOfDay,
    endMin: minuteOfDay,
  })
  .refine((s) => s.startMin < s.endMin, 'startMin must be < endMin');

type Slot = AvailabilityDto['slots'][number];

/** Сортує за (weekday, startMin) і зливає суміжні інтервали (`a.end === b.start`). */
export function normalizeSlots(slots: readonly Slot[]): Slot[] {
  const sorted = [...slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  const out: Slot[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && last.weekday === s.weekday && last.endMin >= s.startMin) {
      last.endMin = Math.max(last.endMin, s.endMin);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Вхід `PUT`-у доступності: перевіряє кратність і перетини, сортує й зливає суміжні. */
export const availabilityInputSchema = z
  .object({
    timezone: ianaTimezone,
    slots: z.array(slotSchema).max(7 * 48),
    busyDates: z.array(isoDate).max(366),
  })
  .superRefine((v, ctx) => {
    const sorted = [...v.slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.weekday === cur.weekday && cur.startMin < prev.endMin) {
        ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Overlapping intervals' });
        return;
      }
    }
  })
  .transform((v): AvailabilityDto => ({
    timezone: v.timezone,
    slots: normalizeSlots(v.slots as Slot[]),
    busyDates: [...new Set(v.busyDates)].sort(),
  }));

export type AvailabilityInput = z.input<typeof availabilityInputSchema>;
