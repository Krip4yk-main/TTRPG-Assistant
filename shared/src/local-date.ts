const DEFAULT_TZ = 'Europe/Kyiv';

/**
 * Календарна дата `YYYY-MM-DD` у часовому поясі користувача.
 * Невідомий/некоректний пояс — Europe/Kyiv.
 */
export function localDate(d: Date, timeZone: string | null | undefined): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  if (timeZone) {
    try {
      return fmt(timeZone);
    } catch {
      // RangeError: Invalid time zone — падаємо на типовий пояс.
    }
  }
  return fmt(DEFAULT_TZ);
}
