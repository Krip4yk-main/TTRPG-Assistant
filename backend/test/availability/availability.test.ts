import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createSession } from '../../src/auth/session.service.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

async function login(userId: number): Promise<string> {
  const { token } = await createSession(deps, userId, {});
  return `nri_sid=${token}; nri_csrf=t`;
}
const call = (method: 'get' | 'put', path: string, cookie: string, body?: object) =>
  request(app)[method](path).set('Cookie', cookie).set('X-CSRF-Token', 't').send(body);

describe('availability', () => {
  it('GET returns empty calendar with users.timezone', async () => {
    const u = await createUser(db, { nickname: 'A', timezone: 'Europe/Warsaw' });
    const res = await call('get', '/api/me/availability', await login(u.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: 'Europe/Warsaw', slots: [], busyDates: [] });
  });

  it('PUT with overlapping slots is 400 VALIDATION', async () => {
    const u = await createUser(db, { nickname: 'A' });
    const res = await call('put', '/api/me/availability', await login(u.id), {
      timezone: 'Europe/Kyiv',
      slots: [
        { weekday: 0, startMin: 600, endMin: 720 },
        { weekday: 0, startMin: 660, endMin: 780 },
      ],
      busyDates: [],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('VALIDATION');
  });

  it('PUT replaces previous slots, normalizes and stores timezone', async () => {
    const u = await createUser(db, { nickname: 'A' });
    const cookie = await login(u.id);
    await call('put', '/api/me/availability', cookie, {
      timezone: 'Europe/Kyiv',
      slots: [{ weekday: 1, startMin: 0, endMin: 60 }],
      busyDates: ['2030-01-01'],
    });
    const res = await call('put', '/api/me/availability', cookie, {
      timezone: 'America/New_York',
      slots: [
        { weekday: 3, startMin: 720, endMin: 780 },
        { weekday: 3, startMin: 600, endMin: 720 },
      ],
      busyDates: ['2030-02-02', '2030-02-02'],
    });
    expect(res.status).toBe(200);
    const expected = {
      timezone: 'America/New_York',
      slots: [{ weekday: 3, startMin: 600, endMin: 780 }],
      busyDates: ['2030-02-02'],
    };
    expect(res.body).toEqual(expected);
    expect((await call('get', '/api/me/availability', cookie)).body).toEqual(expected);
  });

  it("another user's calendar is not reachable", async () => {
    const a = await createUser(db, { nickname: 'A' });
    const b = await createUser(db, { nickname: 'B' });
    await call('put', '/api/me/availability', await login(a.id), {
      timezone: 'Europe/Kyiv',
      slots: [{ weekday: 0, startMin: 0, endMin: 30 }],
      busyDates: [],
    });
    expect((await call('get', '/api/me/availability', await login(b.id))).body.slots).toEqual([]);
    expect((await request(app).get(`/api/users/${a.publicId}/availability`)).status).toBe(404);
    expect((await request(app).get('/api/me/availability')).status).toBe(401);
  });
});
