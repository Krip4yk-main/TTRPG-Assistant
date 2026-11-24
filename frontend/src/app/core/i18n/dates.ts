import { Injectable, type Provider } from '@angular/core';
import {
  DateAdapter,
  MAT_DATE_LOCALE,
  NativeDateAdapter,
  provideNativeDateAdapter,
} from '@angular/material/core';

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

/** Момент часу для показу (`2 бер. 2027 р., 19:00`) у поясі `timeZone`. */
export function formatDateTime(
  iso: string,
  timeZone: string | null | undefined,
  { showZone = false }: FormatDateTimeOptions = {},
): string {
  const opts: Intl.DateTimeFormatOptions = showZone
    ? {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }
    : { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('uk-UA', { ...opts, timeZone: timeZone ?? undefined }).format(
      new Date(iso),
    );
  } catch {
    // Невідомий пояс — показуємо в поясі браузера.
    return new Intl.DateTimeFormat('uk-UA', opts).format(new Date(iso));
  }
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
