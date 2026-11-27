import { CALENDAR_IMPORT_URL_MAX } from '@nri/shared';
import { assertFetchableUrl, SafeFetchError } from '../../http/safe-fetch.js';
import { CalendarImportError } from './errors.js';

/**
 * Захист від SSRF для iCal — спільне ядро `http/safe-fetch.ts` (діапазони адрес, перевірка
 * URL); тут лише нормалізація посилання календаря.
 */
export { isBlockedAddress, literalHost } from '../../http/safe-fetch.js';

/**
 * Нормалізує посилання користувача: `webcal://` → `https://`; дозволено лише https, без
 * логіна/пароля, порт — стандартний 443 (порожній), хост — доменне ім'я або публічна IP.
 * Помилка — `invalid_url` (або `blocked_address` для IP-літерала приватної мережі).
 */
export function normalizeIcsUrl(raw: string, opts: { allowedPorts?: readonly string[] } = {}): URL {
  const input = raw.trim();
  if (input.length === 0 || input.length > CALENDAR_IMPORT_URL_MAX) {
    throw new CalendarImportError('invalid_url');
  }
  let url: URL;
  try {
    url = new URL(/^webcals?:\/\//i.test(input) ? input.replace(/^webcals?:/i, 'https:') : input);
  } catch {
    throw new CalendarImportError('invalid_url');
  }
  try {
    assertFetchableUrl(url, opts);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      throw new CalendarImportError(
        err.reason === 'blocked_address' ? 'blocked_address' : 'invalid_url',
      );
    }
    throw err;
  }
  url.hash = '';
  return url;
}
