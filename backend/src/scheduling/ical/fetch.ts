import {
  CALENDAR_IMPORT_MAX_BYTES,
  CALENDAR_IMPORT_MAX_REDIRECTS,
  CALENDAR_IMPORT_TIMEOUT_MS,
} from '@nri/shared';
import { createSafeGet, SafeFetchError, type SafeFetchOptions } from '../../http/safe-fetch.js';
import { CalendarImportError } from './errors.js';

export { createDnsResolve, type ResolvedAddress } from '../../http/safe-fetch.js';

/** Завантажує ICS за (уже нормалізованим) URL; невдача — `CalendarImportError` з кодом. */
export type IcsFetcher = (url: URL) => Promise<string>;

export interface IcsFetcherOptions extends SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Загальний user-agent без жодних даних користувача. */
const USER_AGENT = 'NRI-Assistant-Calendar/1.0';

/**
 * Безпечне завантаження iCal поверх `createSafeGet` (SSRF, IP-пінінг, перевірка кожного
 * перенаправлення): до 2 перенаправлень, дедлайн 10 с на все, тіло до 2 МБ, без стиснення;
 * відповідь має бути схожою на iCal (не HTML/JSON/картинка, починається з `BEGIN:VCALENDAR`).
 * Помилки містять лише код — без URL, хоста чи IP.
 */
export function createIcsFetcher(opts: IcsFetcherOptions = {}): IcsFetcher {
  const get = createSafeGet({
    resolve: opts.resolve,
    isBlocked: opts.isBlocked,
    request: opts.request,
    allowedPorts: opts.allowedPorts,
    timeoutMs: opts.timeoutMs ?? CALENDAR_IMPORT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? CALENDAR_IMPORT_MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? CALENDAR_IMPORT_MAX_REDIRECTS,
    userAgent: USER_AGENT,
    accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
    acceptHeaders: (headers) => {
      const type = String(headers['content-type'] ?? '').toLowerCase();
      return !/^(text\/html|application\/xhtml|application\/json|image\/)/.test(type);
    },
    body: 'buffer',
  });

  return async (url: URL) => {
    let body: Buffer | null;
    try {
      ({ body } = await get(url));
    } catch (err) {
      if (err instanceof SafeFetchError) {
        throw new CalendarImportError(err.reason === 'bad_content' ? 'not_calendar' : err.reason);
      }
      throw err;
    }
    const text = (body ?? Buffer.alloc(0)).toString('utf8');
    if (!/^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text)) throw new CalendarImportError('not_calendar');
    return text;
  };
}
