import { BlockList, isIP } from 'node:net';
import { CALENDAR_IMPORT_URL_MAX } from '@nri/shared';
import { CalendarImportError } from './errors.js';

/**
 * Захист від SSRF: адреси, на які сервер ніколи не ходить по iCal. IPv4 — усі спеціальні
 * діапазони (RFC 6890): «цей» мережі, приватні, CGNAT, loopback, link-local (зокрема
 * 169.254.169.254 — метадані хмари), документаційні, бенчмарк, multicast, зарезервовані,
 * broadcast. IPv6 — дозволено лише глобальний unicast `2000::/3` без спеціальних підмереж
 * (документація, Teredo, 6to4, NAT64 — вони тунелюють до довільних IPv4); IPv4-mapped/compat
 * адреси перевіряються як вкладений IPv4.
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
  assertFetchableUrl(url, opts);
  url.hash = '';
  return url;
}

/** Перевірка URL перед кожним запитом (зокрема ціль перенаправлення). */
export function assertFetchableUrl(
  url: URL,
  opts: { allowedPorts?: readonly string[] } = {},
): void {
  if (url.protocol !== 'https:') throw new CalendarImportError('invalid_url');
  if (url.username || url.password) throw new CalendarImportError('invalid_url');
  const host = literalHost(url.hostname);
  if (!host) throw new CalendarImportError('invalid_url');
  if (isIP(host) && isBlockedAddress(host)) throw new CalendarImportError('blocked_address');
  if (!isIP(host)) {
    // Однослівні (`localhost`, `intranet`) і службові зони — це внутрішні імена.
    const lower = host.toLowerCase().replace(/\.$/, '');
    if (
      !lower.includes('.') ||
      /\.(localhost|local|internal|intranet|lan|home\.arpa)$/.test(lower)
    ) {
      throw new CalendarImportError('blocked_address');
    }
  }
  if (!(opts.allowedPorts ?? ['']).includes(url.port)) throw new CalendarImportError('invalid_url');
}

/** Хост без дужок IPv6. */
export function literalHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
