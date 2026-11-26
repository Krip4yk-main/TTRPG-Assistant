import { toZoned, type Weekday } from '@nri/shared';
import { formatTime } from '../../core/i18n/dates';

/**
 * Конкретний момент для списку варіантів — у поясі глядача, без назви поясу, з днем тижня:
 * «пт, 27 лист., 19:00».
 */
export function formatSlot(iso: string, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat('uk-UA', { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('uk-UA', opts).format(new Date(iso));
  }
}

/**
 * Регулярний варіант («день тижня + час» у поясі гри) у поясі глядача — за його першою
 * сесією: у іншому поясі сесія може припасти на сусідній день.
 */
export function weeklySlot(iso: string, timeZone: string): { weekday: Weekday; time: string } {
  try {
    return { weekday: toZoned(new Date(iso), timeZone).weekday, time: formatTime(iso, timeZone) };
  } catch {
    const d = new Date(iso);
    return { weekday: ((d.getDay() + 6) % 7) as Weekday, time: formatTime(iso, timeZone) };
  }
}
