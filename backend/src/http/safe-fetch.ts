import { Resolver } from 'node:dns/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Безпечний GET зовнішнього посилання користувача (iCal, обкладинки): захист від SSRF, DNS
 * rebinding, повільних і завеликих відповідей. Спільне ядро; предметні обгортки (iCal —
 * `scheduling/ical/fetch.ts`, картинки — `http/image-url.ts`) перекладають коди помилок у свої.
 */

/**
 * Код невдачі (лише код — без URL, хоста чи IP, тож помилку безпечно логувати):
 * `invalid_url` — не https, логін/пароль, нестандартний порт; `blocked_address` — приватна,
 * локальна чи службова адреса (зокрема серед відповідей DNS або в перенаправленні);
 * `bad_content` — відповідь не того типу (або стиснена, хоча просили `identity`).
 */
export type SafeFetchReason =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'connect_failed'
  | 'timeout'
  | 'redirect'
  | 'too_large'
  | 'http_gone'
  | 'http_status'
  | 'bad_content';

export class SafeFetchError extends Error {
  constructor(public readonly reason: SafeFetchReason) {
    super(`safe fetch failed: ${reason}`);
    this.name = 'SafeFetchError';
  }
}

// ---------- SSRF: адреси ----------

/**
 * Адреси, на які сервер ніколи не ходить. IPv4 — усі спеціальні діапазони (RFC 6890): «цей»
 * мережі, приватні, CGNAT, loopback, link-local (зокрема 169.254.169.254 — метадані хмари),
 * документаційні, бенчмарк, multicast, зарезервовані, broadcast. IPv6 — дозволено лише
 * глобальний unicast `2000::/3` без спеціальних підмереж (документація, Teredo, 6to4, NAT64 —
 * вони тунелюють до довільних IPv4); IPv4-mapped/compat адреси перевіряються як вкладений IPv4.
 */
const v4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  v4.addSubnet(net, prefix, 'ipv4');
}

const v6Special = new BlockList();
for (const [net, prefix] of [
  ['2001::', 23], // IETF protocol assignments, зокрема Teredo 2001::/32
  ['2001:db8::', 32], // документація
  ['2002::', 16], // 6to4
  ['3fff::', 20], // документація (RFC 9637)
] as const) {
  v6Special.addSubnet(net, prefix, 'ipv6');
}

/** 16 байтів IPv6-адреси (вхід — валідний IPv6 за `isIP`, з можливою зоною `%eth0`). */
function ipv6Bytes(ip: string): number[] {
  let s = ip.split('%')[0]!.toLowerCase();
  // Хвіст у вигляді IPv4 (`::ffff:1.2.3.4`) → дві 16-бітні групи.
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const b = m[1]!.split('.').map(Number);
    s =
      s.slice(0, -m[1]!.length) +
      `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

/** Чи заборонено з'єднуватися з цією IP-адресою (нерозпізнане — заборонено). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.split('%')[0]!);
  if (kind === 4) return v4.check(ip, 'ipv4');
  if (kind !== 6) return true;
  const b = ipv6Bytes(ip);
  if (b.length !== 16) return true;
  const zero10 = b.slice(0, 10).every((x) => x === 0);
  // IPv4-mapped `::ffff:a.b.c.d` і застарілі IPv4-compatible `::a.b.c.d` — як вкладений IPv4.
  if (zero10 && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
    const embedded = b.slice(12).join('.');
    // `::` і `::1` теж потрапляють сюди: 0.0.0.0/8 заборонено.
    return v4.check(embedded, 'ipv4');
  }
  // Лише глобальний unicast 2000::/3 (fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 тощо — ні).
  if ((b[0]! & 0xe0) !== 0x20) return true;
  return v6Special.check(ip.split('%')[0]!, 'ipv6');
}

/** Хост без дужок IPv6. */
export function literalHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Перевірка URL перед кожним запитом (зокрема ціль перенаправлення): лише https, без
 * логіна/пароля, порт — стандартний (порожній) або з `allowedPorts`, хост — доменне ім'я
 * (не однослівне й не службова зона) або публічна IP.
 */
export function assertFetchableUrl(
  url: URL,
  opts: { allowedPorts?: readonly string[] } = {},
): void {
  if (url.protocol !== 'https:') throw new SafeFetchError('invalid_url');
  if (url.username || url.password) throw new SafeFetchError('invalid_url');
  const host = literalHost(url.hostname);
  if (!host) throw new SafeFetchError('invalid_url');
  if (isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('blocked_address');
  if (!isIP(host)) {
    // Однослівні (`localhost`, `intranet`) і службові зони — це внутрішні імена.
    const lower = host.toLowerCase().replace(/\.$/, '');
    if (
      !lower.includes('.') ||
      /\.(localhost|local|internal|intranet|lan|home\.arpa)$/.test(lower)
    ) {
      throw new SafeFetchError('blocked_address');
    }
  }
  if (!(opts.allowedPorts ?? ['']).includes(url.port)) throw new SafeFetchError('invalid_url');
}

// ---------- DNS ----------

export interface ResolvedAddress {
  address: string;
  family: number;
}

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
    const [a, aaaa] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const out: ResolvedAddress[] = [
      ...(a.status === 'fulfilled' ? a.value.map((address) => ({ address, family: 4 })) : []),
      ...(aaaa.status === 'fulfilled' ? aaaa.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (out.length === 0) throw new Error('dns: no addresses');
    return out;
  };
}

const defaultResolve = createDnsResolve();

// ---------- безпечний GET ----------

export interface SafeFetchOptions {
  /** DNS-резолвер (тести підставляють свій). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Перевірка адреси (тести дозволяють 127.0.0.1 для локального сервера). */
  isBlocked?: (ip: string) => boolean;
  /** Транспорт (тести — `http.request` до локального сервера; у роботі — лише https). */
  request?: typeof httpsRequest;
  /** Дозволені порти (`''` — стандартний); у роботі — лише 443. */
  allowedPorts?: readonly string[];
}

export interface SafeGetConfig extends SafeFetchOptions {
  /** Загальний дедлайн на все (DNS, з'єднання, заголовки, тіло). */
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** Загальний user-agent без жодних даних користувача. */
  userAgent: string;
  accept: string;
  /** Чи підходять заголовки успішної (2xx) відповіді; `false` — `bad_content`. */
  acceptHeaders?: (headers: IncomingHttpHeaders) => boolean;
  /**
   * `buffer` — тіло (до `maxBytes`) повертається; `measure` — лише перевірка розміру: за
   * чесного `Content-Length` у межах ліміту з'єднання закривається одразу, без нього тіло
   * читається й відкидається, доки не скінчиться або не перевищить ліміт.
   */
  body: 'buffer' | 'measure';
}

export interface SafeGetResult {
  headers: IncomingHttpHeaders;
  /** `null` у режимі `measure`. */
  body: Buffer | null;
}

export type SafeGet = (url: URL) => Promise<SafeGetResult>;

const GONE = new Set([401, 403, 404, 410]);

/** Скільки перевірених адрес пробувати по черзі, якщо з'єднання з попередньою не вдалось. */
const MAX_CONNECT_ATTEMPTS = 3;

/** Невдале з'єднання до відповіді сервера — можна спробувати наступну адресу. */
class ConnectError extends SafeFetchError {}

/**
 * Безпечний GET:
 * - лише https; кожен хост резолвиться заздалегідь, і **будь-яка** заборонена адреса серед
 *   відповідей DNS — відмова (`blocked_address`); з'єднання йде на вже перевірену IP (SNI і
 *   перевірка сертифіката — за іменем хоста), тож DNS rebinding між перевіркою й з'єднанням
 *   неможливий; після з'єднання адреса сокета перевіряється ще раз; не з'єдналось — наступна
 *   перевірена адреса (до 3); DNS — c-ares з таймаутом 2 с (`createDnsResolve`);
 * - перенаправлення — до `maxRedirects`, кожне з тими самими перевірками;
 * - загальний дедлайн `timeoutMs` на все (повільна відповідь обривається), тіло до `maxBytes`
 *   (за `Content-Length`, а без нього потік обривається, щойно ліміт перевищено), без стиснення.
 * Помилки — `SafeFetchError` лише з кодом.
 */
export function createSafeGet(cfg: SafeGetConfig): SafeGet {
  const resolve = cfg.resolve ?? defaultResolve;
  const isBlocked = cfg.isBlocked ?? isBlockedAddress;
  const request = cfg.request ?? httpsRequest;
  const { timeoutMs, maxBytes, maxRedirects } = cfg;

  return async (start: URL) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let url = start;
      for (let hop = 0; ; hop++) {
        const res = await fetchOnce(url, ac.signal);
        if (res.kind === 'done') return res.result;
        if (hop >= maxRedirects) throw new SafeFetchError('redirect');
        let next: URL;
        try {
          next = new URL(res.location, url);
          assertFetchableUrl(next, { allowedPorts: cfg.allowedPorts });
        } catch (err) {
          if (err instanceof SafeFetchError && err.reason === 'blocked_address') throw err;
          throw new SafeFetchError('redirect');
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
      if (isBlocked(host)) throw new SafeFetchError('blocked_address');
      return [{ address: host, family }];
    }
    let addrs: ResolvedAddress[];
    try {
      addrs = await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new SafeFetchError('timeout'));
          signal.addEventListener('abort', () => reject(new SafeFetchError('timeout')), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError('dns_failed');
    }
    if (addrs.length === 0) throw new SafeFetchError('dns_failed');
    if (addrs.some((a) => isBlocked(a.address))) throw new SafeFetchError('blocked_address');
    return addrs;
  }

  type Hop = { kind: 'done'; result: SafeGetResult } | { kind: 'redirect'; location: string };

  /** Усі адреси вже перевірені; наступну пробуємо лише якщо попередня не з'єдналась. */
  async function fetchOnce(url: URL, signal: AbortSignal): Promise<Hop> {
    const targets = (await pickAddresses(url, signal)).slice(0, MAX_CONNECT_ATTEMPTS);
    for (let i = 0; ; i++) {
      try {
        return await requestTo(url, targets[i]!, signal);
      } catch (err) {
        if (!(err instanceof ConnectError) || signal.aborted || i + 1 >= targets.length) {
          throw err instanceof ConnectError ? new SafeFetchError(err.reason) : err;
        }
      }
    }
  }

  function requestTo(url: URL, target: ResolvedAddress, signal: AbortSignal): Promise<Hop> {
    const hostname = literalHost(url.hostname);
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let responded = false;
      const fail = (reason: SafeFetchReason) => {
        if (settled) return;
        settled = true;
        req.destroy();
        rejectPromise(
          reason === 'connect_failed' && !responded
            ? new ConnectError(reason)
            : new SafeFetchError(reason),
        );
      };
      const done = (v: Hop) => {
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
          'user-agent': cfg.userAgent,
          accept: cfg.accept,
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
        if (encoding !== 'identity') return fail('bad_content');
        if (cfg.acceptHeaders && !cfg.acceptHeaders(res.headers)) return fail('bad_content');
        const declared = Number(res.headers['content-length']);
        const hasDeclared =
          res.headers['content-length'] !== undefined && Number.isFinite(declared);
        if (hasDeclared && declared > maxBytes) return fail('too_large');
        if (cfg.body === 'measure' && hasDeclared) {
          // Розмір відомий і в межах — тіло не потрібне: закриваємо з'єднання.
          done({ kind: 'done', result: { headers: res.headers, body: null } });
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return fail('too_large');
          if (cfg.body === 'buffer') chunks.push(chunk);
        });
        res.on('error', () => fail(signal.aborted ? 'timeout' : 'connect_failed'));
        res.on('aborted', () => fail(signal.aborted ? 'timeout' : 'connect_failed'));
        res.on('end', () => {
          if (settled) return;
          const body = cfg.body === 'buffer' ? Buffer.concat(chunks) : null;
          done({ kind: 'done', result: { headers: res.headers, body } });
        });
      });
      req.end();
    });
  }
}
