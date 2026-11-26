import { normalizeSlots, type AvailabilityDto } from '../contracts/availability.js';
import {
  COMMON_TIMES_STEP_MINUTES,
  COMMON_TIMES_TOP,
  type CommonTimeStatus,
  type OneOffCandidateDto,
  type RegularCandidateDto,
} from '../contracts/scheduling.js';
import {
  segmentsFitSlots,
  segmentsFromParts,
  segmentsTouchBusyDate,
  type BusyInterval,
} from './fit.js';
import {
  dayNumber,
  fromDayNumber,
  toZoned,
  weekdayOf,
  zonedToUtc,
  type Weekday,
  type ZonedParts,
} from './tz.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Учасник підбору: календар у його власному поясі + уже зібрані зайняті проміжки. */
export interface CommonTimesPerson {
  userId: number;
  /** Пояс акаунта: у ньому задано `slots` і `busyDates`. */
  timezone: string;
  slots: AvailabilityDto['slots'];
  busyDates: readonly string[];
  /** Зайнятість: сесії інших ігор, імпортовані інтервали тощо (UTC). */
  busy: readonly BusyInterval[];
  /**
   * Чи є в учасника календар: тижневі слоти АБО імпортована зайнятість. Без календаря
   * учасник ніколи не «може» — лише «не може» (відомий конфлікт) або «невідомо».
   */
  hasCalendar: boolean;
}

export interface CommonTimesInput {
  /** Пояс гри: сітка кандидатів — у ньому. */
  timezone: string;
  durationMinutes: number;
  from: Date;
  to: Date;
  people: readonly CommonTimesPerson[];
  /** Чи шукати регулярні кандидати (для разових ігор — ні). За замовчуванням так. */
  regular?: boolean;
  /** Скільки кандидатів кожного виду повернути; за замовчуванням 5. */
  top?: number;
  /** Крок сітки, хв; за замовчуванням 30. */
  stepMinutes?: number;
  /**
   * Разові кандидати, яких не пропонувати (до вибору топу, тож вони не витісняють сусідів):
   * розумне перенесення прибирає поточний час сесії й час інших сесій гри.
   */
  excludeOneOff?: (start: Date, end: Date) => boolean;
}

export interface CommonTimesResult {
  regular: RegularCandidateDto[];
  oneOff: OneOffCandidateDto[];
}

/** Точка сітки: можливий початок сесії. */
export interface GridPoint {
  start: Date;
  end: Date;
  /** День тижня й хвилини від півночі в поясі гри. */
  weekday: Weekday;
  startMin: number;
}

/**
 * Вікно підбору `[from, to)`. `weekOf` (`YYYY-MM-DD`) — тиждень пн 00:00 … наступний пн 00:00
 * у поясі гри, що містить цю дату; інакше `weeks` тижнів від `now`. Початок не раніший за
 * `now`; якщо вікно вже минуло, `from ≥ to` (порожній результат).
 */
export function commonTimesWindow(
  tz: string,
  now: Date,
  opts: { weeks: number; weekOf?: string },
): { from: Date; to: Date } {
  if (opts.weekOf) {
    const [y, m, d] = opts.weekOf.split('-').map(Number) as [number, number, number];
    const monday = dayNumber(y, m, d) - weekdayOf(y, m, d);
    const at = (n: number) => zonedToUtc({ ...fromDayNumber(n), hour: 0, minute: 0 }, tz);
    const start = at(monday);
    const to = at(monday + 7);
    return { from: start < now ? now : start, to };
  }
  return { from: now, to: new Date(now.getTime() + opts.weeks * 7 * DAY) };
}

/**
 * Усі початки сесії в `[from, to)` на сітці `step` хв локального часу гри. Локальний час,
 * якого не існує (весняний перехід), пропускається; осіннє перекриття дає раніший момент.
 */
export function commonTimesGrid(
  tz: string,
  from: Date,
  to: Date,
  durationMinutes: number,
  step = COMMON_TIMES_STEP_MINUTES,
): GridPoint[] {
  if (!(from < to)) return [];
  const a = toZoned(from, tz);
  const b = toZoned(to, tz);
  const first = dayNumber(a.year, a.month, a.day);
  const last = dayNumber(b.year, b.month, b.day);
  const dur = durationMinutes * MINUTE;
  const out: GridPoint[] = [];
  for (let n = first; n <= last; n++) {
    const date = fromDayNumber(n);
    const weekday = weekdayOf(date.year, date.month, date.day);
    for (let min = 0; min < 1440; min += step) {
      const hour = Math.floor(min / 60);
      const minute = min % 60;
      const start = zonedToUtc({ ...date, hour, minute }, tz);
      if (start < from || start >= to) continue;
      const back = toZoned(start, tz);
      if (back.day !== date.day || back.hour !== hour || back.minute !== minute) continue;
      out.push({ start, end: new Date(start.getTime() + dur), weekday, startMin: min });
    }
  }
  return out;
}

/** Перевірка перетину з набором інтервалів за O(log n): префіксний максимум кінців. */
function busyChecker(intervals: readonly BusyInterval[]): (s: number, e: number) => boolean {
  const sorted = intervals
    .map((i) => [i.start.getTime(), i.end.getTime()] as const)
    .filter(([s, e]) => s < e)
    .sort((x, y) => x[0] - y[0]);
  const starts = sorted.map((i) => i[0]);
  const maxEnd: number[] = [];
  let m = -Infinity;
  for (const [, e] of sorted) maxEnd.push((m = Math.max(m, e)));
  return (s, e) => {
    // Кількість інтервалів зі start < e.
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! < e) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && maxEnd[lo - 1]! > s;
  };
}

/** Оцінка однієї сесії для одного учасника. */
export interface CommonTimeVerdict {
  status: CommonTimeStatus;
  /** «Не може», бо сесія поза тижневими слотами (структурно, а не разовий виняток). */
  outsideSlots: boolean;
}

/**
 * Оцінює кожну точку сітки для кожного учасника. Порядок результату — як `people`.
 *
 * «Не може»: дата відрізка — зайнята дата; перетин із `busy`; є тижневі слоти, але сесія
 * (розбита по днях у поясі учасника) не вміщується в них. Інакше «може», якщо є календар,
 * або «невідомо».
 */
export function evaluateGrid(
  points: readonly GridPoint[],
  people: readonly CommonTimesPerson[],
): CommonTimeVerdict[][] {
  const partsCache = new Map<string, { s: ZonedParts[]; e: ZonedParts[] }>();
  const partsFor = (tz: string) => {
    let c = partsCache.get(tz);
    if (!c) {
      c = { s: points.map((p) => toZoned(p.start, tz)), e: points.map((p) => toZoned(p.end, tz)) };
      partsCache.set(tz, c);
    }
    return c;
  };
  return people.map((person) => {
    const parts = partsFor(person.timezone);
    const slots = normalizeSlots(person.slots);
    const hasSlots = slots.length > 0;
    const busyDates = new Set(person.busyDates);
    const isBusy = busyChecker(person.busy);
    return points.map((p, i): CommonTimeVerdict => {
      const segs = segmentsFromParts(parts.s[i]!, parts.e[i]!);
      if (segmentsTouchBusyDate(segs, busyDates) || isBusy(p.start.getTime(), p.end.getTime())) {
        return { status: 'cannot', outsideSlots: false };
      }
      if (hasSlots && !segmentsFitSlots(segs, slots)) {
        return { status: 'cannot', outsideSlots: true };
      }
      return { status: person.hasCalendar ? 'can' : 'unknown', outsideSlots: false };
    });
  });
}

function counts(statuses: readonly { status: CommonTimeStatus }[]) {
  let can = 0;
  let cannot = 0;
  let unknown = 0;
  for (const s of statuses) {
    if (s.status === 'can') can++;
    else if (s.status === 'cannot') cannot++;
    else unknown++;
  }
  return { can, cannot, unknown };
}

/**
 * Статус учасника для регулярного кандидата з `n` сесій — більшість тижнів: «може», якщо може
 * на > половині сесій; «не може», якщо не може на ≥ половині; інакше «невідомо» (лише для
 * учасника без календаря, у якого конфлікти — меншість тижнів). Кожен тиждень оцінено окремо:
 * разові винятки (зайнята дата, сесія іншої гри, подія календаря) і тижні, коли сесія
 * виходить за тижневі слоти (зсув DST між поясами, ніч переходу), знімають лише свій тиждень
 * (`weeksCan < weeks`); `outsideSlotsWeeks` — скільки тижнів саме поза слотами.
 */
export function regularStatus(verdicts: readonly CommonTimeVerdict[]): {
  status: CommonTimeStatus;
  weeksCan: number;
  outsideSlotsWeeks: number;
} {
  const n = verdicts.length;
  const c = counts(verdicts);
  const outsideSlotsWeeks = verdicts.filter((v) => v.outsideSlots).length;
  const base = { weeksCan: c.can, outsideSlotsWeeks };
  if (c.can * 2 > n) return { status: 'can', ...base };
  if (c.cannot * 2 >= n && c.cannot > 0) return { status: 'cannot', ...base };
  return { status: 'unknown', ...base };
}

const WEEK_MIN = 7 * 1440;

/** Регулярні кандидати перетинаються в тижневому циклі (зокрема через північ і нд → пн). */
function weeklyClash(
  a: { weekday: number; startMin: number },
  b: { weekday: number; startMin: number },
  durationMinutes: number,
): boolean {
  const d = Math.abs(a.weekday * 1440 + a.startMin - (b.weekday * 1440 + b.startMin)) % WEEK_MIN;
  return Math.min(d, WEEK_MIN - d) < durationMinutes;
}

/**
 * Найкращі `top` кандидатів, що не перетинаються між собою (інакше топ заповнили б сусідні
 * точки сітки одного вечора). Кандидати без жодного «може» не пропонуються.
 */
function pickTop<T extends { can: number }>(
  sorted: readonly { c: T; t: number }[],
  top: number,
  clash: (a: T, b: T) => boolean,
): T[] {
  const out: T[] = [];
  for (const { c } of sorted) {
    if (out.length >= top) break;
    if (c.can < 1) continue;
    if (out.some((o) => clash(o, c))) continue;
    out.push(c);
  }
  return out;
}

/**
 * Підбір спільного часу (чиста функція; дані збирає бекенд). Ранжування: більше «може»,
 * далі менше «не може», (для регулярних — більше сумарних тижнів «може»), далі раніше.
 */
export function findCommonTimes(input: CommonTimesInput): CommonTimesResult {
  const top = input.top ?? COMMON_TIMES_TOP;
  const points = commonTimesGrid(
    input.timezone,
    input.from,
    input.to,
    input.durationMinutes,
    input.stepMinutes,
  );
  const verdicts = evaluateGrid(points, input.people);
  const durMs = input.durationMinutes * MINUTE;

  const oneOffAll = points.flatMap((p, i) => {
    if (input.excludeOneOff?.(p.start, p.end)) return [];
    const statuses = input.people.map((person, k) => ({
      userId: person.userId,
      status: verdicts[k]![i]!.status,
    }));
    const c: OneOffCandidateDto = {
      startsAt: p.start.toISOString(),
      endsAt: p.end.toISOString(),
      ...counts(statuses),
      statuses,
    };
    return [{ c, t: p.start.getTime() }];
  });
  oneOffAll.sort((a, b) => b.c.can - a.c.can || a.c.cannot - b.c.cannot || a.t - b.t);
  const startOf = (c: OneOffCandidateDto) => Date.parse(c.startsAt);
  const oneOff = pickTop(
    oneOffAll,
    top,
    (a, b) => startOf(a) < startOf(b) + durMs && startOf(b) < startOf(a) + durMs,
  );

  let regular: RegularCandidateDto[] = [];
  if (input.regular ?? true) {
    const groups = new Map<number, number[]>();
    points.forEach((p, i) => {
      const key = p.weekday * 1440 + p.startMin;
      const g = groups.get(key);
      if (g) g.push(i);
      else groups.set(key, [i]);
    });
    const all = [...groups.values()].map((idx) => {
      const p = points[idx[0]!]!;
      const statuses = input.people.map((person, k) => ({
        userId: person.userId,
        ...regularStatus(idx.map((i) => verdicts[k]![i]!)),
      }));
      const c: RegularCandidateDto = {
        weekday: p.weekday,
        startMin: p.startMin,
        weeks: idx.length,
        firstStartsAt: p.start.toISOString(),
        ...counts(statuses),
        statuses,
      };
      return { c, t: p.start.getTime(), sum: statuses.reduce((s, x) => s + x.weeksCan, 0) };
    });
    all.sort((a, b) => b.c.can - a.c.can || a.c.cannot - b.c.cannot || b.sum - a.sum || a.t - b.t);
    regular = pickTop(all, top, (a, b) => weeklyClash(a, b, input.durationMinutes));
  }
  return { regular, oneOff };
}
