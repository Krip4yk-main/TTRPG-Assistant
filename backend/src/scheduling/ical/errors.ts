import type { CalendarImportErrorCode } from '@nri/shared';

/**
 * Невдача завантаження/розбору iCal — лише код причини. Повідомлення — сам код: посилання,
 * хост, IP чи вміст відповіді сюди не потрапляють, тож помилку безпечно логувати.
 */
export class CalendarImportError extends Error {
  constructor(public readonly reason: CalendarImportErrorCode) {
    super(`calendar import failed: ${reason}`);
    this.name = 'CalendarImportError';
  }
}
