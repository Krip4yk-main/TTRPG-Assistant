/** 0 = понеділок … 6 = неділя. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface LocalDateTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface ZonedParts extends LocalDateTime {
  weekday: Weekday;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** День тижня (0 = пн) календарної дати. */
export function weekdayOf(year: number, month: number, day: number): Weekday {
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) as Weekday;
}

/** Номер дня від епохи для календарної дати (для арифметики дат без поясів). */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY);
}

/** Календарна дата за номером дня. */
export function fromDayNumber(n: number): { year: number; month: number; day: number } {
  const d = new Date(n * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Локальні дата й час моменту `d` у поясі `tz` (секунди відкидаються). */
export function toZoned(d: Date, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const year = p.year!;
  const month = p.month!;
  const day = p.day!;
  return {
    year,
    month,
    day,
    hour: p.hour!,
    minute: p.minute!,
    weekday: weekdayOf(year, month, day),
  };
}

/** Зсув поясу (мс) у момент `t`: локальний час − UTC. */
function offsetAt(t: number, tz: string): number {
  const z = toZoned(new Date(t), tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute);
  const truncated = Math.floor(t / MINUTE) * MINUTE;
  return asUtc - truncated;
}

/**
 * Момент UTC для локального часу `local` у поясі `tz`.
 *
 * DST визначено детерміновано:
 * - **проміжок** (локального часу не існує, весняний перехід) — зсув уперед на довжину
 *   проміжку: 03:30 при переході 03:00→04:00 дає 04:30 за новим часом;
 * - **перекриття** (локальний час буває двічі, осінній перехід) — раніший момент, тобто
 *   зсув, що діяв до переходу.
 * Припущення: у вікні ±1 доба навколо `local` щонайбільше один перехід поясу.
 */
export function zonedToUtc(local: LocalDateTime, tz: string): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const before = offsetAt(wall - DAY, tz);
  const after = offsetAt(wall + DAY, tz);
  const candidates = [wall - before, wall - after].filter((t) => offsetAt(t, tz) === wall - t);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Проміжок: беремо зсув до переходу — момент потрапляє після переходу, зсунутий уперед.
  return new Date(wall - before);
}
