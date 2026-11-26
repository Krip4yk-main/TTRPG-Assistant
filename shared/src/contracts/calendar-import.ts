import { z } from 'zod';

/**
 * Імпорт зайнятості з приватного iCal-посилання (Plan 12 Task 4). Одне посилання на
 * користувача; сервер періодично завантажує його й зберігає лише інтервали зайнятості
 * (без назв, описів, місць) на горизонті `CALENDAR_IMPORT_HORIZON_DAYS`. Посилання — фактично
 * пароль: зберігається зашифрованим і ніколи не повертається API (лише хост).
 */

/** Горизонт імпорту від «зараз»: 8 тижнів. */
export const CALENDAR_IMPORT_HORIZON_DAYS = 56;
/** Автоматичне оновлення: кожні 3 год. */
export const CALENDAR_IMPORT_SYNC_EVERY_MS = 3 * 3_600_000;
/** Ручне «Оновити» — не частіше ніж раз на 5 хв. */
export const CALENDAR_IMPORT_MANUAL_SYNC_MS = 5 * 60_000;
/** Стільки невдач поспіль — імпорт «зламаний», автооновлення зупиняється до повторного збереження. */
export const CALENDAR_IMPORT_MAX_FAILURES = 5;
/** Межі завантаження. */
export const CALENDAR_IMPORT_TIMEOUT_MS = 10_000;
export const CALENDAR_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const CALENDAR_IMPORT_MAX_REDIRECTS = 2;
/** Найбільше подій (повторів) у горизонті; решта відкидається. */
export const CALENDAR_IMPORT_MAX_OCCURRENCES = 2000;
/** Найдовше посилання. */
export const CALENDAR_IMPORT_URL_MAX = 2048;

/**
 * Код причини невдачі завантаження/розбору (текст — `calendarImport.errors.<code>`):
 * - `invalid_url` — не https (webcal:// перетворюється на https://), з логіном/паролем, з
 *   нестандартним портом тощо;
 * - `blocked_address` — хост веде на приватну/локальну адресу;
 * - `dns_failed` — хост не знайдено; `connect_failed` — не вдалося з'єднатись (зокрема TLS);
 * - `timeout` — довше за 10 с; `too_large` — понад 2 МБ;
 * - `http_gone` — 401/403/404/410 (посилання відкликано або неправильне);
 * - `http_status` — інша помилка сервера; `redirect` — забагато або недозволене перенаправлення;
 * - `not_calendar` — відповідь не схожа на iCal; `parse_failed` — не вдалося розібрати;
 * - `too_complex` — розбір триває задовго (зловмисний або зламаний файл).
 */
export const CALENDAR_IMPORT_ERROR_CODES = [
  'invalid_url',
  'blocked_address',
  'dns_failed',
  'connect_failed',
  'timeout',
  'too_large',
  'http_gone',
  'http_status',
  'redirect',
  'not_calendar',
  'parse_failed',
  'too_complex',
] as const;
export type CalendarImportErrorCode = (typeof CALENDAR_IMPORT_ERROR_CODES)[number];

/** `PUT /api/me/calendar-import`. */
export const calendarImportInputSchema = z
  .object({ url: z.string().trim().min(1).max(CALENDAR_IMPORT_URL_MAX) })
  .strict();
export type CalendarImportInput = z.infer<typeof calendarImportInputSchema>;

/**
 * `GET|PUT /api/me/calendar-import`, `POST /api/me/calendar-import/sync`. Посилання не
 * повертається ніколи — лише `host` (напр. `calendar.google.com`).
 */
export interface CalendarImportStatusDto {
  /** Імпорт увімкнено на сервері (задано ключ шифрування). */
  available: boolean;
  connected: boolean;
  host: string | null;
  /** Остання успішна синхронізація (ISO UTC). */
  lastSyncAt: string | null;
  /** Остання спроба (успішна чи ні). */
  lastAttemptAt: string | null;
  /** Причина останньої невдачі; `null` — остання спроба вдалась. */
  lastError: CalendarImportErrorCode | null;
  /** Невдач поспіль. */
  failures: number;
  /**
   * `CALENDAR_IMPORT_MAX_FAILURES` невдач поспіль: автооновлення зупинено, імпортовані дані
   * видалено; користувач має зберегти посилання знову (або оновити вручну).
   */
  broken: boolean;
  /** Скільки подій (повторів) у горизонті знайдено під час останньої успішної синхронізації. */
  eventsCount: number;
  /**
   * Під час останньої успішної синхронізації частину подій пропущено через ліміти (понад
   * `CALENDAR_IMPORT_MAX_OCCURRENCES` у горизонті або дуже довга серія повторів) — UI може
   * сказати «частину подій пропущено».
   */
  truncated: boolean;
  /** Коли знову можна натиснути «Оновити» (ISO UTC); `null` — уже можна. */
  nextManualSyncAt: string | null;
}
