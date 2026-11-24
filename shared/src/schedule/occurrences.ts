import { dayNumber, fromDayNumber, toZoned, weekdayOf, zonedToUtc, type Weekday } from './tz.js';

export type Recurrence = 'none' | 'weekly' | 'biweekly' | 'monthly';

export interface ScheduleInput {
  /** Перша сесія, ISO UTC. */
  startsAt: string;
  durationMinutes: number;
  recurrence: Recurrence;
  /** Для weekly/biweekly; `[]` інакше. */
  weekdays: Weekday[];
  /** Пояс гри (майстра); локальний час сесій зберігається через DST. */
  timezone: string;
}

export interface Occurrence {
  start: Date;
  end: Date;
}

/**
 * Сесії розкладу, що починаються в `[fromUtc, toUtc)` і не раніше `startsAt`.
 *
 * - `none` — лише перша сесія.
 * - `weekly` — кожен обраний день тижня о локальному часі першої сесії. Сам `startsAt`
 *   теж мусить бути серед обраних днів, інакше він не потрапляє у видачу. Порожній
 *   `weekdays` дає порожній результат — схема гри має це відхиляти.
 * - `biweekly` — те саме, але лише в парні тижні (пн–нд), рахуючи від тижня першої сесії.
 * - `monthly` — n-й день тижня першої сесії в кожному місяці; 5-й трактується як останній.
 *
 * Тривалість — абсолютна (`durationMinutes` хвилин реального часу).
 */
export function expandOccurrences(s: ScheduleInput, fromUtc: Date, toUtc: Date): Occurrence[] {
  // Якір — ціла хвилина: toZoned відкидає секунди, тож перебудована перша сесія
  // інакше була б раніше за startsAt і випадала б із видачі.
  const firstMs = Math.floor(new Date(s.startsAt).getTime() / 60_000) * 60_000;
  const first = new Date(firstMs);
  const fromMs = Math.max(fromUtc.getTime(), firstMs);
  const toMs = toUtc.getTime();
  if (!(fromMs < toMs) || Number.isNaN(firstMs)) return [];

  const tz = s.timezone;
  const durMs = s.durationMinutes * 60_000;
  const local = toZoned(first, tz);
  const make = (year: number, month: number, day: number): Occurrence => {
    const start = zonedToUtc({ year, month, day, hour: local.hour, minute: local.minute }, tz);
    return { start, end: new Date(start.getTime() + durMs) };
  };
  const out: Occurrence[] = [];
  const push = (o: Occurrence) => {
    const t = o.start.getTime();
    if (t >= fromMs && t < toMs) out.push(o);
  };

  if (s.recurrence === 'none') {
    push({ start: first, end: new Date(firstMs + durMs) });
    return out;
  }

  // Діапазон календарних днів у поясі гри з запасом ±1 доба (зсуви поясів < 24 год).
  const fromLocal = toZoned(new Date(fromMs), tz);
  const toLocal = toZoned(new Date(toMs), tz);
  const firstDay = dayNumber(local.year, local.month, local.day);
  const startDay = Math.max(
    firstDay,
    dayNumber(fromLocal.year, fromLocal.month, fromLocal.day) - 1,
  );
  const endDay = dayNumber(toLocal.year, toLocal.month, toLocal.day) + 1;

  if (s.recurrence === 'weekly' || s.recurrence === 'biweekly') {
    const days = new Set<number>(s.weekdays);
    if (days.size === 0) return out;
    const firstMonday = firstDay - local.weekday;
    for (let n = startDay; n <= endDay; n++) {
      const { year, month, day } = fromDayNumber(n);
      if (!days.has(weekdayOf(year, month, day))) continue;
      if (s.recurrence === 'biweekly' && Math.floor((n - firstMonday) / 7) % 2 !== 0) continue;
      push(make(year, month, day));
    }
    return out;
  }

  // monthly
  const nth = Math.ceil(local.day / 7); // 1..5; 5 = останній
  const wd = local.weekday;
  const startMonth = fromDayNumber(startDay);
  const endMonth = fromDayNumber(endDay);
  let y = startMonth.year;
  let m = startMonth.month;
  while (y < endMonth.year || (y === endMonth.year && m <= endMonth.month)) {
    const firstWd = weekdayOf(y, m, 1);
    const firstMatch = 1 + ((wd - firstWd + 7) % 7);
    let day = firstMatch + (nth - 1) * 7;
    if (nth === 5) {
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      day = firstMatch + Math.floor((daysInMonth - firstMatch) / 7) * 7;
    }
    push(make(y, m, day));
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
