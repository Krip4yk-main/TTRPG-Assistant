import { normalizeSlots, type AvailabilityDto } from '../contracts/availability.js';
import type { Occurrence } from './occurrences.js';
import { dayNumber, fromDayNumber, toZoned, weekdayOf } from './tz.js';

/** Горизонт оцінки відповідності календарю. */
export const FIT_HORIZON_DAYS = 28;

export type AvailabilityFit = 'full' | 'partial' | 'none';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Чи вміщується сесія в доступність гравця. У поясі гравця сесія розбивається на
 * відрізки по календарних днях (через північ — кілька відрізків, що стикуються о
 * 24:00/0:00); кожен відрізок має лежати цілком в одному (злитому) інтервалі свого дня
 * тижня, а жодна з дат відрізків не може бути в `busyDates`. Сесія, що закінчується
 * рівно о 0:00, наступного дня не зачіпає.
 */
function fits(o: Occurrence, slots: AvailabilityDto['slots'], busy: Set<string>, tz: string) {
  const a = toZoned(o.start, tz);
  const b = toZoned(o.end, tz);
  const startDay = dayNumber(a.year, a.month, a.day);
  let endDay = dayNumber(b.year, b.month, b.day);
  let endMin = b.hour * 60 + b.minute;
  if (endMin === 0 && endDay > startDay) {
    endDay--;
    endMin = 1440;
  }
  if (endDay < startDay) return false;
  for (let n = startDay; n <= endDay; n++) {
    const { year, month, day } = fromDayNumber(n);
    if (busy.has(`${year}-${pad(month)}-${pad(day)}`)) return false;
    const segStart = n === startDay ? a.hour * 60 + a.minute : 0;
    const segEnd = n === endDay ? endMin : 1440;
    const wd = weekdayOf(year, month, day);
    const ok = slots.some((s) => s.weekday === wd && s.startMin <= segStart && segEnd <= s.endMin);
    if (!ok) return false;
  }
  return true;
}

/** Зайнятий проміжок часу (напр. сесія гри, де гравець уже учасник). */
export interface BusyInterval {
  start: Date;
  end: Date;
}

/** Перетин напіввідкритих `[start, end)`: інтервали, що лише стикуються, не перетинаються. */
const overlaps = (o: Occurrence, b: BusyInterval): boolean =>
  o.start.getTime() < b.end.getTime() && b.start.getTime() < o.end.getTime();

/**
 * `full` — підходять усі сесії; `partial` — щонайменше половина (але не всі);
 * інакше `none`. Порожній список → `none`. Сесія, що перетинається з будь-яким із
 * `busyIntervals` (зайнятість від ігор гравця), не підходить.
 */
export function availabilityFit(
  occ: Occurrence[],
  a: AvailabilityDto,
  busyIntervals: readonly BusyInterval[] = [],
): AvailabilityFit {
  if (occ.length === 0) return 'none';
  const slots = normalizeSlots(a.slots);
  const busy = new Set(a.busyDates);
  const ok = occ.filter(
    (o) => fits(o, slots, busy, a.timezone) && !busyIntervals.some((b) => overlaps(o, b)),
  ).length;
  if (ok === occ.length) return 'full';
  return ok * 2 >= occ.length ? 'partial' : 'none';
}
