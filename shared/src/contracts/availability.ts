import { z } from 'zod';
import type { Weekday } from '../schedule/tz.js';
import { ianaTimezone, isoDate } from '../schemas/common.js';

/**
 * Тижнева доступність гравця: вільні інтервали (кроком 30 хв) і разові зайняті дати.
 * Слоти — «настінний» час у поясі акаунта (R5): зміна поясу в налаштуваннях акаунта
 * слоти не перераховує (вт 19:00–23:00 лишається вт 19:00–23:00 у новому поясі).
 */
export interface AvailabilityDto {
  /**
   * У відповідях `/api/me/availability` — пояс акаунта (`users.timezone`), лише для читання:
   * `PUT` його ігнорує, змінюється він через `PATCH /api/me/timezone`. У довільному
   * календарі пошуку (`calendar.custom`) — пояс, у якому задано слоти.
   */
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

const slotsField = z.array(slotSchema).max(7 * 48);
const busyDatesField = z.array(isoDate).max(366);

/** Перевірка перетинів слотів одного дня. */
function noOverlaps(v: { slots: readonly Slot[] }, ctx: z.RefinementCtx): void {
  const sorted = [...v.slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.weekday === cur.weekday && cur.startMin < prev.endMin) {
      ctx.addIssue({ code: 'custom', path: ['slots'], message: 'Overlapping intervals' });
      return;
    }
  }
}

const normalized = (v: { slots: readonly Slot[]; busyDates: readonly string[] }) => ({
  slots: normalizeSlots(v.slots),
  busyDates: [...new Set(v.busyDates)].sort(),
});

/**
 * Календар разом із поясом (довільний календар пошуку, `calendar.custom`): перевіряє
 * кратність і перетини, сортує й зливає суміжні.
 */
export const availabilityInputSchema = z
  .object({ timezone: ianaTimezone, slots: slotsField, busyDates: busyDatesField })
  .superRefine((v, ctx) => noOverlaps(v as { slots: Slot[] }, ctx))
  .transform((v): AvailabilityDto => ({
    timezone: v.timezone,
    ...normalized(v as { slots: Slot[]; busyDates: string[] }),
  }));

export type AvailabilityInput = z.input<typeof availabilityInputSchema>;

/**
 * Вхід `PUT /api/me/availability`: лише слоти й зайняті дати. Пояс — завжди пояс акаунта;
 * передане поле `timezone` (як у `AvailabilityDto`) ігнорується й не змінює `users.timezone`.
 */
export const availabilityUpdateSchema = z
  .object({ slots: slotsField, busyDates: busyDatesField })
  .superRefine((v, ctx) => noOverlaps(v as { slots: Slot[] }, ctx))
  .transform((v) => normalized(v as { slots: Slot[]; busyDates: string[] }));

export type AvailabilityUpdateInput = z.input<typeof availabilityUpdateSchema>;
export type AvailabilityUpdate = z.output<typeof availabilityUpdateSchema>;
