import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createImageUrlChecker,
  IMAGE_MAX_BYTES,
  ImageUrlError,
  type ImageUrlCheckerOptions,
} from '../../src/http/image-url.js';
import { isBlockedAddress } from '../../src/http/safe-fetch.js';

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ImageUrlError) return err.reason;
    throw err;
  }
  throw new Error('expected an ImageUrlError');
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('image URL checker (local test server; real transport is https only)', () => {
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

  /** `img.test` → локальний сервер (127.0.0.1 дозволено лише йому); решта — справжні правила. */
  const DNS: Record<string, string[]> = {
    'img.test': ['127.0.0.1'],
    'internal.test': ['10.1.2.3'],
  };
  const opts = (extra: ImageUrlCheckerOptions = {}): ImageUrlCheckerOptions => ({
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
  const url = (path: string, host = 'img.test') => `https://${host}:${port}${path}`;

  it('accepts png/jpeg/webp/gif/avif (with parameters, any case)', async () => {
    const types = ['image/png', 'IMAGE/JPEG', 'image/webp; q=1', 'image/gif', 'image/avif'];
    types.forEach((type, i) =>
      routes.set(`/ok${i}`, (res) =>
        res.writeHead(200, { 'content-type': type, 'content-length': PNG.length }).end(PNG),
      ),
    );
    const check = createImageUrlChecker(opts());
    for (let i = 0; i < types.length; i++) await check(url(`/ok${i}`));
  });

  it('accepts a chunked image without Content-Length under the limit', async () => {
    routes.set('/chunked', (res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG);
      res.end(PNG);
    });
    await createImageUrlChecker(opts())(url('/chunked'));
  });

  it('non-image types → not_image (html, svg, octet-stream, missing)', async () => {
    routes.set('/html', (res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>'),
    );
    routes.set('/svg', (res) =>
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>'),
    );
    routes.set('/bin', (res) =>
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG),
    );
    routes.set('/none', (res) => {
      res.removeHeader('content-type');
      res.writeHead(200).end(PNG);
    });
    const check = createImageUrlChecker(opts());
    expect(await reason(check(url('/html')))).toBe('not_image');
    expect(await reason(check(url('/svg')))).toBe('not_image');
    expect(await reason(check(url('/bin')))).toBe('not_image');
    expect(await reason(check(url('/none')))).toBe('not_image');
  });

  it('6 MB → too_large, declared by Content-Length or streamed without it (stream aborted)', async () => {
    routes.set('/declared', (res) =>
      res
        .writeHead(200, { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) })
        .end(),
    );
    const chunk = Buffer.alloc(256 * 1024);
    let sent = 0;
    routes.set('/stream', (res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const timer = setInterval(() => {
        sent += chunk.length;
        res.write(chunk);
        if (sent >= 6 * 1024 * 1024) {
          clearInterval(timer);
          res.end();
        }
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const check = createImageUrlChecker(opts());
    expect(await reason(check(url('/declared')))).toBe('too_large');
    expect(await reason(check(url('/stream')))).toBe('too_large');
    // Обірвано невдовзі після 5 МБ, а не дочитано до кінця.
    expect(sent).toBeLessThan(6 * 1024 * 1024);
    expect(IMAGE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('127.0.0.1, 10.x and a redirect to 169.254.169.254 → forbidden_address (no connection)', async () => {
    routes.set('/to-meta', (res) =>
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' }).end(),
    );
    const strict = createImageUrlChecker({ ...opts(), isBlocked: isBlockedAddress });
    const before = hits;
    expect(await reason(strict('https://127.0.0.1/a.png'))).toBe('forbidden_address');
    expect(await reason(strict('https://10.0.0.7/a.png'))).toBe('forbidden_address');
    expect(await reason(strict(url('/a.png', 'internal.test')))).toBe('forbidden_address');
    expect(await reason(strict('https://localhost/a.png'))).toBe('forbidden_address');
    expect(hits).toBe(before);
    expect(await reason(createImageUrlChecker(opts())(url('/to-meta')))).toBe('forbidden_address');
  });

  it('redirects: up to 3, each re-checked; more → unreachable', async () => {
    routes.set('/img', (res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
    routes.set('/r1', (res) => res.writeHead(302, { location: '/r2' }).end());
    routes.set('/r2', (res) => res.writeHead(301, { location: '/r3' }).end());
    routes.set('/r3', (res) => res.writeHead(307, { location: '/img' }).end());
    routes.set('/r0', (res) => res.writeHead(302, { location: '/r1' }).end());
    routes.set('/to-http', (res) =>
      res.writeHead(302, { location: `http://img.test:${port}/img` }).end(),
    );
    const check = createImageUrlChecker(opts());
    await check(url('/r1'));
    expect(await reason(check(url('/r0')))).toBe('unreachable');
    expect(await reason(check(url('/to-http')))).toBe('unreachable');
  });

  it('slow response → timeout (5 s by default, overridable)', async () => {
    routes.set('/hang', () => {
      /* ніколи не відповідає */
    });
    const t0 = Date.now();
    expect(await reason(createImageUrlChecker(opts({ timeoutMs: 300 }))(url('/hang')))).toBe(
      'timeout',
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('HTTP errors and unknown hosts → unreachable; non-https, credentials, odd ports → forbidden_address', async () => {
    routes.set('/boom', (res) => res.writeHead(500).end());
    const check = createImageUrlChecker(opts());
    expect(await reason(check(url('/missing')))).toBe('unreachable');
    expect(await reason(check(url('/boom')))).toBe('unreachable');
    expect(await reason(check(url('/a.png', 'nx.test')))).toBe('unreachable');
    expect(await reason(check('http://img.test/a.png'))).toBe('forbidden_address');
    expect(await reason(check('https://u:p@img.test/a.png'))).toBe('forbidden_address');
    expect(await reason(check('https://img.test:8443/a.png'))).toBe('forbidden_address');
  });
});
