import { Resolver } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  CALENDAR_IMPORT_MAX_BYTES,
  CALENDAR_IMPORT_MAX_REDIRECTS,
  CALENDAR_IMPORT_TIMEOUT_MS,
} from '@nri/shared';
import { CalendarImportError } from './errors.js';
import { assertFetchableUrl, isBlockedAddress, literalHost } from './ssrf.js';

/** Завантажує ICS за (уже нормалізованим) URL; невдача — `CalendarImportError` з кодом. */
export type IcsFetcher = (url: URL) => Promise<string>;

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface IcsFetcherOptions {
  /** DNS-резолвер (тести підставляють свій). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Перевірка адреси (тести дозволяють 127.0.0.1 для локального сервера). */
  isBlocked?: (ip: string) => boolean;
  /** Транспорт (тести — `http.request` до локального сервера; у роботі — лише https). */
  request?: typeof httpsRequest;
  /** Дозволені порти (`''` — стандартний); у роботі — лише 443. */
  allowedPorts?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Загальний user-agent без жодних даних користувача. */
const USER_AGENT = 'NRI-Assistant-Calendar/1.0';
const GONE = new Set([401, 403, 404, 410]);

/** Скільки перевірених адрес пробувати по черзі, якщо з'єднання з попередньою не вдалось. */
const MAX_CONNECT_ATTEMPTS = 3;

/**
 * DNS через c-ares (`Resolver`), а не `dns.lookup`: `lookup` займає потік пулу libuv (його
 * ділять файлова система, crypto, zlib) і не скасовується — повільний зловмисний DNS-сервер
 * міг би заблокувати пул. Тут — власний таймаут на запит (2 с, без повторів), A і AAAA
 * паралельно; невдача одного з них не страшна, якщо інший дав адреси. `/etc/hosts` не
 * читається (і не потрібен: внутрішні імена однаково заборонені).
 */
export function createDnsResolve(
  opts: { timeoutMs?: number; servers?: string[] } = {},
): (hostname: string) => Promise<ResolvedAddress[]> {
  const resolver = new Resolver({ timeout: opts.timeoutMs ?? 2_000, tries: 1 });
  if (opts.servers) resolver.setServers(opts.servers);
  return async (hostname) => {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const out: ResolvedAddress[] = [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (out.length === 0) throw new Error('dns: no addresses');
    return out;
  };
}

const defaultResolve = createDnsResolve();

/** Невдале з'єднання до відповіді сервера — можна спробувати наступну адресу. */
class ConnectError extends CalendarImportError {}

/**
 * Безпечне завантаження iCal:
 * - лише https; кожен хост резолвиться заздалегідь, і **будь-яка** заборонена адреса серед
 *   відповідей DNS — відмова (`blocked_address`); з'єднання йде на вже перевірену IP (SNI і
 *   перевірка сертифіката — за іменем хоста), тож DNS rebinding між перевіркою й з'єднанням
 *   неможливий; після з'єднання адреса сокета перевіряється ще раз; не з'єдналось — наступна
 *   перевірена адреса (до 3); DNS — c-ares з таймаутом 2 с (`createDnsResolve`);
 * - перенаправлення — до `maxRedirects` (2), кожне з тими самими перевірками;
 * - загальний дедлайн 10 с на все (DNS, з'єднання, заголовки, тіло — повільна відповідь
 *   обривається), тіло до 2 МБ (потік обривається, щойно ліміт перевищено), без стиснення;
 * - відповідь має бути схожою на iCal (не HTML, починається з `BEGIN:VCALENDAR`).
 * Помилки містять лише код — без URL, хоста чи IP.
 */
export function createIcsFetcher(opts: IcsFetcherOptions = {}): IcsFetcher {
  const resolve = opts.resolve ?? defaultResolve;
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const request = opts.request ?? httpsRequest;
  const timeoutMs = opts.timeoutMs ?? CALENDAR_IMPORT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CALENDAR_IMPORT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? CALENDAR_IMPORT_MAX_REDIRECTS;

  return async (start: URL) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let url = start;
      for (let hop = 0; ; hop++) {
        const res = await fetchOnce(url, ac.signal);
        if (res.kind === 'body') return res.body;
        if (hop >= maxRedirects) throw new CalendarImportError('redirect');
        let next: URL;
        try {
          next = new URL(res.location, url);
          assertFetchableUrl(next, { allowedPorts: opts.allowedPorts });
        } catch (err) {
          if (err instanceof CalendarImportError && err.reason === 'blocked_address') throw err;
          throw new CalendarImportError('redirect');
        }
        url = next;
      }
    } finally {
      clearTimeout(timer);
    }
  };

  async function pickAddresses(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]> {
    const host = literalHost(url.hostname);
    const family = isIP(host);
    if (family) {
      if (isBlocked(host)) throw new CalendarImportError('blocked_address');
      return [{ address: host, family }];
    }
    let addrs: ResolvedAddress[];
    try {
      addrs = await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new CalendarImportError('timeout'));
          signal.addEventListener('abort', () => reject(new CalendarImportError('timeout')), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      if (err instanceof CalendarImportError) throw err;
      throw new CalendarImportError('dns_failed');
    }
    if (addrs.length === 0) throw new CalendarImportError('dns_failed');
    if (addrs.some((a) => isBlocked(a.address))) throw new CalendarImportError('blocked_address');
    return addrs;
  }

  type Result = { kind: 'body'; body: string } | { kind: 'redirect'; location: string };

  /** Усі адреси вже перевірені; наступну пробуємо лише якщо попередня не з'єдналась. */
  async function fetchOnce(url: URL, signal: AbortSignal): Promise<Result> {
    const targets = (await pickAddresses(url, signal)).slice(0, MAX_CONNECT_ATTEMPTS);
    for (let i = 0; ; i++) {
      try {
        return await requestTo(url, targets[i]!, signal);
      } catch (err) {
        if (!(err instanceof ConnectError) || signal.aborted || i + 1 >= targets.length) {
          throw err instanceof ConnectError ? new CalendarImportError(err.reason) : err;
        }
      }
    }
  }

  function requestTo(url: URL, target: ResolvedAddress, signal: AbortSignal): Promise<Result> {
    const hostname = literalHost(url.hostname);
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let responded = false;
      const fail = (reason: ConstructorParameters<typeof CalendarImportError>[0]) => {
        if (settled) return;
        settled = true;
        req.destroy();
        rejectPromise(
          reason === 'connect_failed' && !responded
            ? new ConnectError(reason)
            : new CalendarImportError(reason),
        );
      };
      const done = (v: Parameters<typeof resolvePromise>[0]) => {
        if (settled) return;
        settled = true;
        resolvePromise(v);
      };
      const req = request({
        host: target.address,
        family: target.family,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        servername: isIP(hostname) ? undefined : hostname,
        agent: false,
        signal,
        headers: {
          host: url.host,
          'user-agent': USER_AGENT,
          accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
          'accept-encoding': 'identity',
        },
      });
      req.on('socket', (socket) => {
        socket.once('connect', () => {
          const remote = socket.remoteAddress;
          if (!remote || isBlocked(remote)) fail('blocked_address');
        });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (signal.aborted || err.name === 'AbortError') fail('timeout');
        else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') fail('dns_failed');
        else fail('connect_failed');
      });
      req.on('response', (res: IncomingMessage) => {
        responded = true;
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume();
          if (!location) return fail('redirect');
          return done({ kind: 'redirect', location });
        }
        if (GONE.has(status)) return fail('http_gone');
        if (status < 200 || status >= 300) return fail('http_status');
        const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (encoding !== 'identity') return fail('not_calendar');
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        if (/^(text\/html|application\/xhtml|application\/json|image\/)/.test(type)) {
          return fail('not_calendar');
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) return fail('too_large');
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return fail('too_large');
          chunks.push(chunk);
        });
        res.on('error', () => fail(signal.aborted ? 'timeout' : 'connect_failed'));
        res.on('aborted', () => fail(signal.aborted ? 'timeout' : 'connect_failed'));
        res.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks).toString('utf8');
          if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(body)) return fail('not_calendar');
          done({ kind: 'body', body });
        });
      });
      req.end();
    });
  }
}
