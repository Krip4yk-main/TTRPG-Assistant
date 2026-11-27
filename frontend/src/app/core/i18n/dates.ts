import { Injectable, type Provider } from '@angular/core';
import {
  DateAdapter,
  MAT_DATE_LOCALE,
  NativeDateAdapter,
  provideNativeDateAdapter,
} from '@angular/material/core';
import {
  dayNumber,
  fromDayNumber,
  toZoned,
  weekdayOf,
  zonedToUtc,
  windowEnd,
  type Weekday,
} from '@nri/shared';

const pad = (n: number) => String(n).padStart(2, '0');

/** Локальна календарна дата → `YYYY-MM-DD` (без зсуву через UTC). */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` → локальна північ цієї дати. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Нативний адаптер, що розуміє введення `ДД.ММ.РРРР` (формат uk-UA). */
@Injectable()
export class UkDateAdapter extends NativeDateAdapter {
  override parse(value: unknown, parseFormat?: unknown): Date | null {
    if (typeof value === 'string') {
      const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(value);
      if (m) {
        const date = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        return date.getDate() === Number(m[1]) ? date : this.invalid();
      }
    }
    return super.parse(value, parseFormat);
  }

  override getFirstDayOfWeek(): number {
    return 1;
  }
}

/** Datepicker-провайдери; підключаються у компонентах з полем дати. */
export function provideUkDates(): Provider[] {
  return [
    provideNativeDateAdapter(),
    { provide: MAT_DATE_LOCALE, useValue: 'uk-UA' },
    { provide: DateAdapter, useClass: UkDateAdapter },
  ];
}

/** Джерело поясу браузера; окремий об'єкт, щоб тести могли підмінити пояс гостя. */
export const browserZone = {
  get: (): string => Intl.DateTimeFormat().resolvedOptions().timeZone,
};

/** IANA-пояс браузера (запасний — `Europe/Kyiv`). */
export function browserTimeZone(): string {
  try {
    return browserZone.get() || 'Europe/Kyiv';
  } catch {
    return 'Europe/Kyiv';
  }
}

/**
 * Пояс, у якому глядачеві показуються моменти часу: пояс акаунта, а для гостя — пояс
 * браузера. Єдине джерело для карток, сторінки гри, «Моїх ігор» і пошуку.
 */
export function viewerTimeZone(me: { timezone?: string | null } | null | undefined): string {
  return me?.timezone || browserTimeZone();
}

/** Канонічна назва поясу (`Europe/Kiev` → `Europe/Kyiv`), або сам рядок, якщо пояс невідомий. */
function canonicalZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

/** Чи це різні пояси (з урахуванням псевдонімів IANA). */
export function differentZones(a: string, b: string): boolean {
  return canonicalZone(a) !== canonicalZone(b);
}

export interface FormatDateTimeOptions {
  /** Додати коротку назву поясу (`GMT+1`, `EET`…), напр. коли пояс глядача ≠ поясу гри. */
  showZone?: boolean;
}

function dateTimeOptions(showZone: boolean): Intl.DateTimeFormatOptions {
  return showZone
    ? {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }
    : { dateStyle: 'medium', timeStyle: 'short' };
}

/** Форматер `uk-UA` у поясі `timeZone`; невідомий пояс — пояс браузера. */
function zonedFormat(timeZone: string | null | undefined, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('uk-UA', { ...opts, timeZone: timeZone ?? undefined });
  } catch {
    return new Intl.DateTimeFormat('uk-UA', opts);
  }
}

/** Момент часу для показу (`2 бер. 2027 р., 19:00`) у поясі `timeZone`. */
export function formatDateTime(
  iso: string,
  timeZone: string | null | undefined,
  { showZone = false }: FormatDateTimeOptions = {},
): string {
  return zonedFormat(timeZone, dateTimeOptions(showZone)).format(new Date(iso));
}

/**
 * Час початку сесії: точний момент (як `formatDateTime`) або, якщо задано вікно початку
 * (`windowMinutes`), проміжок «5 груд. 2026 р., 18:00–21:00» (через північ — з обома датами).
 * Кінець вікна — у UTC-мілісекундах (`windowEnd`), тож перехід на літній час його не зсуває.
 */
export function formatWindow(
  iso: string,
  windowMinutes: number | null | undefined,
  timeZone: string | null | undefined,
  { showZone = false }: FormatDateTimeOptions = {},
): string {
  if (!windowMinutes) return formatDateTime(iso, timeZone, { showZone });
  const start = new Date(iso);
  return zonedFormat(timeZone, dateTimeOptions(showZone)).formatRange(
    start,
    windowEnd(start, windowMinutes),
  );
}

/** Лише час (`19:00`) моменту `iso` у поясі `timeZone`. */
export function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  }
}

/**
 * Календарна дата з datepicker-а + `HH:mm` як місцевий час у поясі `timeZone` → момент UTC
 * (ISO, ціла хвилина). Неповні чи некоректні дані — `null`.
 */
export function zonedInputToUtc(date: Date | null, time: string, timeZone: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!date || Number.isNaN(date.getTime()) || !m) return null;
  return zonedToUtc(
    {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: Number(m[1]),
      minute: Number(m[2]),
    },
    timeZone,
  ).toISOString();
}

/** Момент `iso` як поля форми в поясі `timeZone`: дата (місцева північ) і `HH:mm`. */
export function utcToZonedInput(iso: string, timeZone: string): { date: Date; time: string } {
  const z = toZoned(new Date(iso), timeZone);
  return { date: new Date(z.year, z.month - 1, z.day), time: `${pad(z.hour)}:${pad(z.minute)}` };
}

/**
 * Тижневий розклад гри (дні тижня й час у поясі гри) — у поясі глядача: кожен день
 * переводиться окремо, бо в іншому поясі сесія може припасти на сусідній день. Рахується
 * для найближчого тижня від `now` (не від першої сесії), щоб літній/зимовий час був
 * поточним. Дні — без повторів, від понеділка; час — найближчої з цих сесій.
 */
export function weeklyInZone(
  startsAt: string,
  gameTz: string,
  weekdays: readonly Weekday[],
  viewerTz: string,
  now: Date = new Date(),
): { weekdays: Weekday[]; time: string } {
  try {
    const first = toZoned(new Date(startsAt), gameTz);
    const today = toZoned(now, gameTz);
    const base = Math.max(
      dayNumber(first.year, first.month, first.day),
      dayNumber(today.year, today.month, today.day),
    );
    const baseDay = fromDayNumber(base);
    const baseWeekday = weekdayOf(baseDay.year, baseDay.month, baseDay.day);
    const out = new Set<Weekday>();
    let earliest: Date | null = null;
    for (const d of weekdays) {
      const day = fromDayNumber(base + ((d - baseWeekday + 7) % 7));
      const at = zonedToUtc({ ...day, hour: first.hour, minute: first.minute }, gameTz);
      out.add(toZoned(at, viewerTz).weekday);
      if (!earliest || at < earliest) earliest = at;
    }
    const timeAt = earliest ? earliest.toISOString() : startsAt;
    return { weekdays: [...out].sort((a, b) => a - b), time: formatTime(timeAt, viewerTz) };
  } catch {
    return { weekdays: [...weekdays], time: formatTime(startsAt, gameTz) };
  }
}
