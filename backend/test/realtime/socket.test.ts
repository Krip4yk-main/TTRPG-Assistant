import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
} from '../../src/auth/session.service.js';
import { banUser } from '../../src/users/users.service.js';
import { createHttpServer } from '../../src/http-server.js';
import type { RealtimeHub } from '../../src/realtime/socket.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

let deps: AppDeps;
let server: Server;
let hub: RealtimeHub;
let url: string;
const clients: Socket[] = [];

beforeEach(async () => {
  deps = await testDeps();
  await resetDb(deps.db);
  server = createHttpServer(deps);
  hub = deps.realtime!;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub.close();
  await new Promise<void>((r) => server.close(() => r()));
  await closeDeps(deps);
});

function client(headers: Record<string, string> = {}): Socket {
  const c = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: headers,
  });
  clients.push(c);
  return c;
}

const waitFor = <T>(c: Socket, ev: string) => new Promise<T>((r) => c.once(ev, r));

describe('realtime', () => {
  it('rejects without cookie', async () => {
    const err = await waitFor<Error>(client(), 'connect_error');
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('rejects pending users', async () => {
    const u = await createUser(deps.db, { status: 'pending' });
    const { token } = await createSession(deps, u.id, {});
    const err = await waitFor<Error>(client({ cookie: `nri_sid=${token}` }), 'connect_error');
    expect(err.message).toBe('PROFILE_INCOMPLETE');
  });

  it('rejects banned users', async () => {
    const u = await createUser(deps.db, { isBanned: true });
    const { token } = await createSession(deps, u.id, {});
    const err = await waitFor<Error>(client({ cookie: `nri_sid=${token}` }), 'connect_error');
    expect(err.message).toBe('UNAUTHENTICATED');
  });

  it('rejects foreign Origin even with valid cookie', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}`, origin: 'http://evil.example' });
    const err = await waitFor<Error>(c, 'connect_error');
    expect(c.connected).toBe(false);
    expect(err).toBeTruthy();
  });

  it('accepts matching Origin and delivers toUser events', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}`, origin: deps.env.PUBLIC_BASE_URL });
    await waitFor(c, 'connect');
    const got = waitFor<{ x: number }>(c, 'ping');
    hub.toUser(u.id, 'ping', { x: 1 });
    expect(await got).toEqual({ x: 1 });
  });

  it('allows absent Origin (non-browser clients) but rejects foreign one', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}` });
    await waitFor(c, 'connect');
    expect(c.connected).toBe(true);
  });

  it('banUser disconnects an open socket', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}` });
    await waitFor(c, 'connect');
    const gone = waitFor(c, 'disconnect');
    await banUser(deps, u.id);
    await gone;
    expect(c.connected).toBe(false);
  });

  it('polling transport works and never reaches express', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = connect(url, {
      transports: ['polling'],
      reconnection: false,
      extraHeaders: { cookie: `nri_sid=${token}` },
    });
    clients.push(c);
    await waitFor(c, 'connect');
    for (let i = 0; i < 3; i++) {
      const got = waitFor<{ i: number }>(c, 'ping');
      hub.toUser(u.id, 'ping', { i });
      expect(await got).toEqual({ i });
    }
    // Сервер живий, а Express не бачив /socket.io (інакше був би 404 NOT_FOUND з тілом JSON).
    const res = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
    expect(res.status).not.toBe(404);
    expect(await res.text()).not.toContain('NOT_FOUND');
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
  });

  it('logout-all disconnects an open socket', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}` });
    await waitFor(c, 'connect');
    const gone = waitFor(c, 'disconnect');
    await revokeAllUserSessions(deps, u.id);
    await gone;
    expect(c.connected).toBe(false);
  });

  it('logout-all emits session.revoked before disconnect', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}` });
    await waitFor(c, 'connect');
    const order: string[] = [];
    c.on('session.revoked', () => order.push('revoked'));
    const gone = waitFor(c, 'disconnect').then(() => order.push('disconnect'));
    await revokeAllUserSessions(deps, u.id);
    await gone;
    expect(order).toEqual(['revoked', 'disconnect']);
  });

  it('single logout emits session.revoked only to that session', async () => {
    const u = await createUser(deps.db);
    const a = await createSession(deps, u.id, {});
    const b = await createSession(deps, u.id, {});
    const ca = client({ cookie: `nri_sid=${a.token}` });
    const cb = client({ cookie: `nri_sid=${b.token}` });
    await Promise.all([waitFor(ca, 'connect'), waitFor(cb, 'connect')]);
    let bGot = false;
    cb.on('session.revoked', () => (bGot = true));
    const revoked = waitFor(ca, 'session.revoked');
    await revokeSession(deps, a.token, u.id);
    await revoked;
    await new Promise((r) => setTimeout(r, 100));
    expect(bGot).toBe(false);
  });

  it('banUser emits session.revoked', async () => {
    const u = await createUser(deps.db);
    const { token } = await createSession(deps, u.id, {});
    const c = client({ cookie: `nri_sid=${token}` });
    await waitFor(c, 'connect');
    const revoked = waitFor(c, 'session.revoked');
    await banUser(deps, u.id);
    await revoked;
  });

  it('logout disconnects only that session', async () => {
    const u = await createUser(deps.db);
    const a = await createSession(deps, u.id, {});
    const b = await createSession(deps, u.id, {});
    const ca = client({ cookie: `nri_sid=${a.token}` });
    const cb = client({ cookie: `nri_sid=${b.token}` });
    await Promise.all([waitFor(ca, 'connect'), waitFor(cb, 'connect')]);
    const gone = waitFor(ca, 'disconnect');
    await revokeSession(deps, a.token, u.id);
    await gone;
    expect(cb.connected).toBe(true);
  });
});
