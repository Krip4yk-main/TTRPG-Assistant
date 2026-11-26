import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CalendarImportError } from '../../src/scheduling/ical/errors.js';
import { createIcsFetcher, type IcsFetcherOptions } from '../../src/scheduling/ical/fetch.js';
import { isBlockedAddress, normalizeIcsUrl } from '../../src/scheduling/ical/ssrf.js';

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CalendarImportError) return err.reason;
    throw err;
  }
  throw new Error('expected a CalendarImportError');
}

function reasonSync(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof CalendarImportError) return err.reason;
    throw err;
  }
  throw new Error('expected a CalendarImportError');
}

describe('SSRF guard: blocked addresses (RF 3)', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast, reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.0.9',
      '0.0.0.0',
      '10.0.0.5',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '192.0.2.10',
      '198.18.0.1',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks IPv6 loopback, unspecified, unique-local, link-local, multicast, mapped/tunnelled', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'fe80::1%eth0',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '64:ff9b::a00:1',
      '2001:db8::1',
      '2002:7f00:1::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of [
      '8.8.8.8',
      '142.250.74.14',
      '1.1.1.1',
      '2a00:1450:4001:82b::200e',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('normalizes URLs: webcal → https, rejects http, credentials, ports, internal names', () => {
    expect(normalizeIcsUrl('webcal://p01-caldav.icloud.com/published/2/abc').href).toBe(
      'https://p01-caldav.icloud.com/published/2/abc',
    );
    expect(
      normalizeIcsUrl(' https://calendar.google.com/calendar/ical/x/private-y/basic.ics#f ').href,
    ).toBe('https://calendar.google.com/calendar/ical/x/private-y/basic.ics');
    expect(reasonSync(() => normalizeIcsUrl('http://calendar.google.com/x.ics'))).toBe(
      'invalid_url',
    );
    expect(reasonSync(() => normalizeIcsUrl('file:///etc/passwd'))).toBe('invalid_url');
    expect(reasonSync(() => normalizeIcsUrl('https://user:pw@example.com/x.ics'))).toBe(
      'invalid_url',
    );
    expect(reasonSync(() => normalizeIcsUrl('https://example.com:8080/x.ics'))).toBe('invalid_url');
    expect(reasonSync(() => normalizeIcsUrl('not a url'))).toBe('invalid_url');
    expect(reasonSync(() => normalizeIcsUrl(`https://example.com/${'a'.repeat(2100)}`))).toBe(
      'invalid_url',
    );
    expect(reasonSync(() => normalizeIcsUrl('https://127.0.0.1/x.ics'))).toBe('blocked_address');
    expect(reasonSync(() => normalizeIcsUrl('https://[::1]/x.ics'))).toBe('blocked_address');
    expect(reasonSync(() => normalizeIcsUrl('https://10.1.2.3/x.ics'))).toBe('blocked_address');
    expect(reasonSync(() => normalizeIcsUrl('https://169.254.169.254/latest/meta-data'))).toBe(
      'blocked_address',
    );
    expect(reasonSync(() => normalizeIcsUrl('https://localhost/x.ics'))).toBe('blocked_address');
    expect(reasonSync(() => normalizeIcsUrl('https://intranet/x.ics'))).toBe('blocked_address');
    expect(reasonSync(() => normalizeIcsUrl('https://printer.local/x.ics'))).toBe(
      'blocked_address',
    );
  });
});

describe('ICS fetcher (local test server; real transport is https only)', () => {
  let server: Server;
  let port = 0;
  let hits = 0;
  const routes = new Map<string, (res: ServerResponse) => void>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      const route = routes.get(req.url ?? '');
      if (route) route(res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** `public.test` → локальний сервер (127.0.0.1 дозволено лише йому); решта — справжні правила. */
  const DNS: Record<string, string[]> = {
    'public.test': ['127.0.0.1'],
    'internal.test': ['192.168.1.10'],
    'mixed.test': ['127.0.0.1', '10.0.0.1'],
    'meta.test': ['169.254.169.254'],
    'v6.test': ['::1'],
  };
  const opts = (extra: IcsFetcherOptions = {}): IcsFetcherOptions => ({
    request: httpRequest,
    allowedPorts: [String(port)],
    resolve: async (host) => {
      const list = DNS[host];
      if (!list) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    isBlocked: (ip) => (ip === '127.0.0.1' ? false : isBlockedAddress(ip)),
    ...extra,
  });
  const url = (host: string, path: string) => new URL(`https://${host}:${port}${path}`);

  it('fetches a calendar with a generic user agent and no compression', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const s2 = createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' }).end(ICS);
    });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const p2 = (s2.address() as AddressInfo).port;
    const body = await createIcsFetcher({ ...opts(), allowedPorts: [String(p2)] })(
      new URL(`https://public.test:${p2}/cal.ics?secret=abc`),
    );
    s2.close();
    expect(body).toBe(ICS);
    expect(seen['user-agent']).toBe('NRI-Assistant-Calendar/1.0');
    expect(seen['accept-encoding']).toBe('identity');
    expect(seen.host).toBe(`public.test:${p2}`);
  });

  it('DNS → private/link-local/loopback is refused before connecting; one bad answer is enough', async () => {
    const f = createIcsFetcher(opts());
    const before = hits;
    expect(await reason(f(url('internal.test', '/ok')))).toBe('blocked_address');
    expect(await reason(f(url('meta.test', '/ok')))).toBe('blocked_address');
    expect(await reason(f(url('v6.test', '/ok')))).toBe('blocked_address');
    expect(await reason(f(url('mixed.test', '/ok')))).toBe('blocked_address');
    expect(await reason(f(url('nx.test', '/ok')))).toBe('dns_failed');
    expect(hits).toBe(before);
    // Справжні правила (без винятку для тестового сервера): 127.0.0.1 заборонено.
    const strict = createIcsFetcher({ ...opts(), isBlocked: isBlockedAddress });
    expect(await reason(strict(url('public.test', '/ok')))).toBe('blocked_address');
    expect(await reason(strict(new URL('https://127.0.0.1/x')))).toBe('blocked_address');
    expect(await reason(strict(new URL('https://[::1]/x')))).toBe('blocked_address');
    expect(hits).toBe(before);
  });

  it('redirects: up to 2, each re-checked; to a private host, to http, or too many — refused', async () => {
    routes.set('/ok', (res) => res.writeHead(200, { 'content-type': 'text/calendar' }).end(ICS));
    routes.set('/r1', (res) => res.writeHead(302, { location: '/r2' }).end());
    routes.set('/r2', (res) =>
      res.writeHead(301, { location: `https://public.test:${port}/ok` }).end(),
    );
    routes.set('/r3', (res) => res.writeHead(302, { location: '/r1' }).end());
    routes.set('/to-private', (res) =>
      res.writeHead(302, { location: `https://internal.test:${port}/ok` }).end(),
    );
    routes.set('/to-loopback', (res) =>
      res.writeHead(302, { location: 'https://127.0.0.1/ok' }).end(),
    );
    routes.set('/to-meta', (res) =>
      res.writeHead(307, { location: 'https://169.254.169.254/latest/meta-data/' }).end(),
    );
    routes.set('/to-http', (res) =>
      res.writeHead(302, { location: `http://public.test:${port}/ok` }).end(),
    );
    routes.set('/no-location', (res) => res.writeHead(302).end());
    const f = createIcsFetcher(opts());
    expect(await f(url('public.test', '/r1'))).toBe(ICS);
    expect(await reason(f(url('public.test', '/r3')))).toBe('redirect');
    expect(await reason(f(url('public.test', '/to-private')))).toBe('blocked_address');
    expect(await reason(f(url('public.test', '/to-loopback')))).toBe('blocked_address');
    expect(await reason(f(url('public.test', '/to-meta')))).toBe('blocked_address');
    expect(await reason(f(url('public.test', '/to-http')))).toBe('redirect');
    expect(await reason(f(url('public.test', '/no-location')))).toBe('redirect');
  });

  it('oversized body: declared or streamed beyond the cap is aborted', async () => {
    const big = 'X'.repeat(64 * 1024);
    routes.set('/declared', (res) =>
      res
        .writeHead(200, { 'content-type': 'text/calendar', 'content-length': String(5_000_000) })
        .end(),
    );
    let streamedChunks = 0;
    routes.set('/stream', (res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.write('BEGIN:VCALENDAR\r\n');
      const timer = setInterval(() => {
        streamedChunks++;
        res.write(big);
        if (streamedChunks >= 200) {
          clearInterval(timer);
          res.end();
        }
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const f = createIcsFetcher(opts({ maxBytes: 256 * 1024 }));
    expect(await reason(f(url('public.test', '/declared')))).toBe('too_large');
    expect(await reason(f(url('public.test', '/stream')))).toBe('too_large');
    expect(streamedChunks).toBeLessThan(200);
  });

  it('slow response (headers or a dripping body) hits the overall timeout', async () => {
    routes.set('/hang', () => {
      /* ніколи не відповідає */
    });
    routes.set('/drip', (res) => {
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.write('BEGIN:VCALENDAR\r\n');
      const timer = setInterval(() => res.write('X'), 50);
      res.on('close', () => clearInterval(timer));
    });
    const f = createIcsFetcher(opts({ timeoutMs: 300 }));
    const t0 = Date.now();
    expect(await reason(f(url('public.test', '/hang')))).toBe('timeout');
    expect(await reason(f(url('public.test', '/drip')))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('HTTP errors and non-calendar responses', async () => {
    routes.set('/gone', (res) => res.writeHead(410).end());
    routes.set('/denied', (res) => res.writeHead(403).end());
    routes.set('/boom', (res) => res.writeHead(500).end());
    routes.set('/html', (res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>'),
    );
    routes.set('/text', (res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('hello'));
    routes.set('/gzip', (res) =>
      res.writeHead(200, { 'content-type': 'text/calendar', 'content-encoding': 'gzip' }).end('x'),
    );
    routes.set('/plain-ics', (res) =>
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(`﻿${ICS}`),
    );
    const f = createIcsFetcher(opts());
    expect(await reason(f(url('public.test', '/missing')))).toBe('http_gone');
    expect(await reason(f(url('public.test', '/gone')))).toBe('http_gone');
    expect(await reason(f(url('public.test', '/denied')))).toBe('http_gone');
    expect(await reason(f(url('public.test', '/boom')))).toBe('http_status');
    expect(await reason(f(url('public.test', '/html')))).toBe('not_calendar');
    expect(await reason(f(url('public.test', '/text')))).toBe('not_calendar');
    expect(await reason(f(url('public.test', '/gzip')))).toBe('not_calendar');
    expect(await f(url('public.test', '/plain-ics'))).toContain('BEGIN:VCALENDAR');
  });

  it('error messages carry only the reason code (no URL, host or IP)', async () => {
    const f = createIcsFetcher(opts());
    for (const u of [url('internal.test', '/secret-token'), url('public.test', '/secret-token')]) {
      try {
        await f(u);
      } catch (err) {
        expect(String((err as Error).message)).not.toMatch(
          /secret-token|internal\.test|public\.test|192\.168|127\.0/,
        );
      }
    }
  });
});
