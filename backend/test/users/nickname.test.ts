import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { resolveLogin } from '../../src/auth/identity.service.js';
import { createSession } from '../../src/auth/session.service.js';
import { events } from '../../src/db/schema/index.js';
import { generatePublicId, PUBLIC_ID_ALPHABET } from '../../src/users/nickname.js';
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

async function cookieFor(userId: number): Promise<string> {
  const { token } = await createSession(deps, userId, {});
  return `nri_sid=${token}; nri_csrf=t`;
}
const patchNick = (cookie: string, nickname: string) =>
  request(app)
    .patch('/api/me/nickname')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', 't')
    .send({ nickname });

describe('generatePublicId', () => {
  it('returns 10 chars from the alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const id = generatePublicId();
      expect(id).toHaveLength(10);
      for (const ch of id) expect(PUBLIC_ID_ALPHABET).toContain(ch);
    }
  });
});

describe('publicId', () => {
  it('new pending user gets a publicId via resolveLogin', async () => {
    const { userId } = await resolveLogin(deps, { provider: 'telegram', subject: '1' });
    const cookie = await cookieFor(userId);
    const res = await request(app).get('/api/me').set('Cookie', cookie);
    expect(res.body.publicId).toMatch(/^[2-9a-hjkmnp-z]{10}$/);
  });

  it('column is NOT NULL and UNIQUE', async () => {
    const [col] = (await db.execute(
      sql`SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'public_id'`,
    )) as unknown as [{ n: string }[]];
    expect(col![0]!.n).toBe('NO');
    const a = await createUser(db, { publicId: 'abcdefghjk' });
    expect(a.publicId).toBe('abcdefghjk');
    await expect(createUser(db, { publicId: 'abcdefghjk' })).rejects.toThrow();
  });
});

describe('PATCH /api/me/nickname', () => {
  it('changes nickname, keeps publicId, logs event', async () => {
    const u = await createUser(db, { nickname: 'Gandalf', birthDate: '2000-01-01' });
    const res = await patchNick(await cookieFor(u.id), 'Saruman');
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('Saruman');
    expect(res.body.publicId).toBe(u.publicId);
    const rows = await db.select().from(events);
    expect(rows.map((e) => e.type)).toContain('user.nickname_changed');
  });

  it('own nickname with different case is allowed', async () => {
    const u = await createUser(db, { nickname: 'Saruman', birthDate: '2000-01-01' });
    const res = await patchNick(await cookieFor(u.id), 'SARUMAN');
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('SARUMAN');
  });

  it('taken by another user (case-insensitive) -> 409 NICKNAME_TAKEN', async () => {
    await createUser(db, { nickname: 'Saruman', birthDate: '2000-01-01' });
    const u = await createUser(db, { nickname: 'Gandalf', birthDate: '2000-01-01' });
    const res = await patchNick(await cookieFor(u.id), 'saruman');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NICKNAME_TAKEN');
  });

  it('concurrent Saruman/saruman from two users -> exactly one 200, one 409', async () => {
    const a = await createUser(db, { nickname: 'Alpha', birthDate: '2000-01-01' });
    const b = await createUser(db, { nickname: 'Beta', birthDate: '2000-01-01' });
    const [ca, cb] = [await cookieFor(a.id), await cookieFor(b.id)];
    const res = await Promise.all([patchNick(ca, 'Saruman'), patchNick(cb, 'saruman')]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('invalid nickname -> 400', async () => {
    const u = await createUser(db, { nickname: 'Gandalf', birthDate: '2000-01-01' });
    expect((await patchNick(await cookieFor(u.id), 'a!')).status).toBe(400);
  });

  it('pending user -> 403 PROFILE_INCOMPLETE', async () => {
    const u = await createUser(db, { status: 'pending' });
    const res = await patchNick(await cookieFor(u.id), 'Saruman');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_INCOMPLETE');
  });
});
