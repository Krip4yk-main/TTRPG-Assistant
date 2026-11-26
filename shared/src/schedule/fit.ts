import { normalizeSlots, type AvailabilityDto } from '../contracts/availability.js';
import type { Occurrence } from './occurrences.js';
import {
  dayNumber,
  fromDayNumber,
  toZoned,
  weekdayOf,
  type Weekday,
  type ZonedParts,
} from './tz.js';

/** Горизонт оцінки відповідності календарю. */
export const FIT_HORIZON_DAYS = 28;

export type AvailabilityFit = 'full' | 'partial' | 'none';

const pad = (n: number) => String(n).padStart(2, '0');

/** Відрізок сесії в межах одного календарного дня поясу гравця. */
export interface DaySegment {
  /** `YYYY-MM-DD` у поясі гравця. */
  date: string;
  weekday: Weekday;
  /** Хвилини від початку дня, `0 ≤ startMin < endMin ≤ 1440`. */
  startMin: number;
  endMin: number;
}

/**
 * Відрізки сесії по календарних днях у поясі `tz` (через північ — кілька відрізків, що
 * стикуються о 24:00/0:00). Сесія, що закінчується рівно о 0:00, наступного дня не зачіпає.
 * Порожній масив — некоректний проміжок (кінець раніше початку).
 */
export function daySegments(o: Occurrence, tz: string): DaySegment[] {
  return segmentsFromParts(toZoned(o.start, tz), toZoned(o.end, tz));
}

/** Те саме з уже обчисленими локальними частинами початку й кінця (для пакетних обчислень). */
export function segmentsFromParts(a: ZonedParts, b: ZonedParts): DaySegment[] {
  const startDay = dayNumber(a.year, a.month, a.day);
  let endDay = dayNumber(b.year, b.month, b.day);
  let endMin = b.hour * 60 + b.minute;
  if (endMin === 0 && endDay > startDay) {
    endDay--;
    endMin = 1440;
  }
  if (endDay < startDay) return [];
  const out: DaySegment[] = [];
  for (let n = startDay; n <= endDay; n++) {
    const { year, month, day } = fromDayNumber(n);
    out.push({
      date: `${year}-${pad(month)}-${pad(day)}`,
      weekday: weekdayOf(year, month, day),
      startMin: n === startDay ? a.hour * 60 + a.minute : 0,
      endMin: n === endDay ? endMin : 1440,
    });
  }
  return out;
}

/** Кожен відрізок лежить цілком в одному (злитому, див. `normalizeSlots`) слоті свого дня. */
export function segmentsFitSlots(
  segs: readonly DaySegment[],
  slots: AvailabilityDto['slots'],
): boolean {
  if (segs.length === 0) return false;
  return segs.every((g) =>
    slots.some((s) => s.weekday === g.weekday && s.startMin <= g.startMin && g.endMin <= s.endMin),
  );
}

/** Хоч один відрізок припадає на зайняту дату. */
export function segmentsTouchBusyDate(segs: readonly DaySegment[], busy: Set<string>): boolean {
  return segs.some((g) => busy.has(g.date));
}

/**
 * Чи вміщується сесія в доступність гравця: кожен денний відрізок (у поясі гравця) лежить
 * цілком в одному слоті свого дня тижня, а жодна з дат відрізків не в `busyDates`.
 */
function fits(o: Occurrence, slots: AvailabilityDto['slots'], busy: Set<string>, tz: string) {
  const segs = daySegments(o, tz);
  return segs.length > 0 && !segmentsTouchBusyDate(segs, busy) && segmentsFitSlots(segs, slots);
}

/** Зайнятий проміжок часу (напр. сесія гри, де гравець уже учасник). */
export interface BusyInterval {
  start: Date;
  end: Date;
}

/** Перетин напіввідкритих `[start, end)`: інтервали, що лише стикуються, не перетинаються. */
export const intervalsOverlap = (o: Occurrence, b: BusyInterval): boolean =>
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
    (o) => fits(o, slots, busy, a.timezone) && !busyIntervals.some((b) => intervalsOverlap(o, b)),
  ).length;
  if (ok === occ.length) return 'full';
  return ok * 2 >= occ.length ? 'partial' : 'none';
}
