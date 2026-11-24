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

/** Момент часу для показу (`2 бер. 2027 р., 19:00`) у поясі `timeZone`. */
export function formatDateTime(iso: string, timeZone: string | null | undefined): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('uk-UA', { ...opts, timeZone: timeZone ?? undefined }).format(
      new Date(iso),
    );
  } catch {
    // Невідомий пояс — показуємо в поясі браузера.
    return new Intl.DateTimeFormat('uk-UA', opts).format(new Date(iso));
  }
}
