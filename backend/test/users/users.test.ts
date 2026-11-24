import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { resolveLogin, subjectHash } from '../../src/auth/identity.service.js';
import { createSession, hashToken } from '../../src/auth/session.service.js';
import { authIdentities, identityTombstones, sessions, users } from '../../src/db/schema/index.js';
import { changeBirthDate, completeProfile, deleteAccount } from '../../src/users/users.service.js';
import { localDate } from '@nri/shared';
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

const yearsAgo = (y: number, dayOffset = 0): string => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};

async function login(userId: number): Promise<string> {
  const { token } = await createSession(deps, userId, {});
  return `nri_sid=${token}; nri_csrf=t`;
}
const call = (
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  cookie: string,
  body?: object,
) => request(app)[method](path).set('Cookie', cookie).set('X-CSRF-Token', 't').send(body);

async function pending(provider: 'telegram' | 'google' = 'telegram', subject = '1') {
  const { userId } = await resolveLogin(deps, { provider, subject, displayName: 'P' });
  return userId;
}

describe('GET /api/me', () => {
  it('returns MeDto with identities', async () => {
    const u = await createUser(db, { nickname: 'Hero', birthDate: '2000-01-01' });
    await db
      .insert(authIdentities)
      .values({ userId: u.id, provider: 'google', subject: 'g', displayName: 'G' });
    const res = await call('get', '/api/me', await login(u.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: u.id,
      nickname: 'Hero',
      avatarUrl: null,
      birthDate: '2000-01-01',
      role: 'user',
      status: 'active',
      timezone: 'Europe/Kyiv',
      locale: 'uk',
      identities: [{ provider: 'google', displayName: 'G' }],
    });
    expect((await request(app).get('/api/me')).status).toBe(401);
  });
});

describe('complete-profile', () => {
  it('activates the profile and the session sees it immediately', async () => {
    const id = await pending();
    const cookie = await login(id);
    await call('get', '/api/me', cookie); // прогріти кеш
    const res = await call('post', '/api/me/complete-profile', cookie, {
      nickname: 'Hero',
      birthDate: yearsAgo(20),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nickname: 'Hero', status: 'active' });
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row!.status).toBe('active');
    expect((await call('get', '/api/test/active', cookie)).status).toBe(200);
  });

  it('13-year-old: 422 AGE_TOO_LOW and the pending user is removed', async () => {
    const id = await pending();
    const cookie = await login(id);
    const res = await call('post', '/api/me/complete-profile', cookie, {
      nickname: 'Kid',
      birthDate: yearsAgo(14, 1),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AGE_TOO_LOW');
    expect(await db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
    expect(await db.select().from(authIdentities)).toHaveLength(0);
    expect(await db.select().from(identityTombstones)).toHaveLength(0);
    expect((await call('get', '/api/me', cookie)).status).toBe(401);
  });

  it('exactly 14 is allowed', async () => {
    const id = await pending();
    const res = await call('post', '/api/me/complete-profile', await login(id), {
      nickname: 'Teen',
      birthDate: yearsAgo(14),
    });
    expect(res.status).toBe(200);
  });

  it('409 NICKNAME_TAKEN (case-insensitive), user stays pending', async () => {
    await createUser(db, { nickname: 'Hero' });
    const id = await pending();
    const res = await call('post', '/api/me/complete-profile', await login(id), {
      nickname: 'hero',
      birthDate: yearsAgo(20),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NICKNAME_TAKEN');
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row!.status).toBe('pending');
  });

  it('400 for active user and for invalid body', async () => {
    const u = await createUser(db, { nickname: 'A1x' });
    const res = await call('post', '/api/me/complete-profile', await login(u.id), {
      nickname: 'Other',
      birthDate: yearsAgo(20),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ reason: 'ALREADY_ACTIVE' });
    const id = await pending('google', '2');
    const bad = await call('post', '/api/me/complete-profile', await login(id), { nickname: 'x' });
    expect(bad.status).toBe(400);
  });
});

describe('age check uses the user timezone for "today"', () => {
  // 00:30 24.11 у Києві (UTC+2), але ще 23.11 за UTC.
  const clock = () => new Date('2026-11-23T22:30:00Z');

  it('localDate formats in the given zone and falls back to Europe/Kyiv', () => {
    expect(localDate(clock(), 'Europe/Kyiv')).toBe('2026-11-24');
    expect(localDate(clock(), 'UTC')).toBe('2026-11-23');
    expect(localDate(clock(), 'Not/AZone')).toBe('2026-11-24');
    expect(localDate(clock(), undefined)).toBe('2026-11-24');
  });

  it('14th birthday in Kyiv just after local midnight is allowed', async () => {
    const id = await pending();
    const r = await completeProfile(
      deps,
      id,
      { nickname: 'Teen', birthDate: '2012-11-24', timezone: 'Europe/Kyiv' },
      clock,
    );
    expect(r).toEqual({ ok: true });
  });

  it('same clock with timezone UTC is AGE_TOO_LOW', async () => {
    const id = await pending();
    const r = await completeProfile(
      deps,
      id,
      { nickname: 'Teen', birthDate: '2012-11-24', timezone: 'UTC' },
      clock,
    );
    expect(r).toEqual({ ok: false, rejected: 'AGE_TOO_LOW' });
  });

  it('without input timezone uses the stored user timezone (default Europe/Kyiv)', async () => {
    const id = await pending();
    const r = await completeProfile(deps, id, { nickname: 'Teen', birthDate: '2012-11-24' }, clock);
    expect(r).toEqual({ ok: true });
  });

  it('changeBirthDate uses the stored user timezone', async () => {
    const kyiv = await createUser(db, { nickname: 'K1', birthDate: '2000-01-01' });
    await changeBirthDate(deps, kyiv.id, '2012-11-24', clock);
    const utc = await createUser(db, { nickname: 'U1', birthDate: '2000-01-01', timezone: 'UTC' });
    await expect(changeBirthDate(deps, utc.id, '2012-11-24', clock)).rejects.toMatchObject({
      code: 'AGE_TOO_LOW',
    });
  });
});

describe('PATCH /api/me/birth-date', () => {
  it('second change within 30 days is 409 with availableAt; same date is a no-op', async () => {
    const u = await createUser(db, { nickname: 'Hero', birthDate: '2000-01-01' });
    const cookie = await login(u.id);
    const ok = await call('patch', '/api/me/birth-date', cookie, { birthDate: '1999-05-05' });
    expect(ok.status).toBe(200);
    expect(ok.body.birthDate).toBe('1999-05-05');
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    const res = await call('patch', '/api/me/birth-date', cookie, { birthDate: '1998-05-05' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BIRTH_DATE_COOLDOWN');
    expect(new Date(res.body.error.details.availableAt).getTime()).toBe(
      after!.birthDateChangedAt!.getTime() + 30 * 86400_000,
    );
    const same = await call('patch', '/api/me/birth-date', cookie, { birthDate: '1999-05-05' });
    expect(same.status).toBe(200);
  });

  it('allowed after cooldown; too young is 422', async () => {
    const old = new Date(Date.now() - 31 * 86400_000);
    const u = await createUser(db, {
      nickname: 'Hero',
      birthDate: '2000-01-01',
      birthDateChangedAt: old,
    });
    const cookie = await login(u.id);
    const young = await call('patch', '/api/me/birth-date', cookie, { birthDate: yearsAgo(10) });
    expect(young.status).toBe(422);
    expect(young.body.error.code).toBe('AGE_TOO_LOW');
    const ok = await call('patch', '/api/me/birth-date', cookie, { birthDate: '1990-01-01' });
    expect(ok.status).toBe(200);
  });

  it('pending user gets 403 PROFILE_INCOMPLETE', async () => {
    const id = await pending();
    const res = await call('patch', '/api/me/birth-date', await login(id), {
      birthDate: '1990-01-01',
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/me/identities/:provider', () => {
  it('last identity: 409 LAST_IDENTITY; with two: 200', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    await db.insert(authIdentities).values({ userId: u.id, provider: 'telegram', subject: 't' });
    const cookie = await login(u.id);
    const last = await call('delete', '/api/me/identities/telegram', cookie);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_IDENTITY');
    await db.insert(authIdentities).values({ userId: u.id, provider: 'google', subject: 'g' });
    const ok = await call('delete', '/api/me/identities/telegram', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.identities).toEqual([{ provider: 'google', displayName: null }]);
  });

  it('404 when not linked, 400 for unknown provider', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    await db.insert(authIdentities).values({ userId: u.id, provider: 'telegram', subject: 't' });
    const cookie = await login(u.id);
    expect((await call('delete', '/api/me/identities/google', cookie)).status).toBe(404);
    expect((await call('delete', '/api/me/identities/nope', cookie)).status).toBe(400);
  });
});

describe('DELETE /api/me', () => {
  const ident = { provider: 'telegram' as const, subject: '777', displayName: 'T' };

  it('deletes unbanned account; re-login creates a NEW pending user', async () => {
    const { userId } = await resolveLogin(deps, ident);
    await db
      .update(users)
      .set({ status: 'active', nickname: 'Hero', birthDate: '2000-01-01', avatarUrl: 'x' })
      .where(eq(users.id, userId));
    const cookie = await login(userId);
    const res = await call('delete', '/api/me', cookie);
    expect(res.status).toBe(204);
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row).toMatchObject({
      status: 'deleted',
      nickname: null,
      avatarUrl: null,
      birthDate: null,
    });
    expect(row!.deletedAt).not.toBeNull();
    expect(
      await db.select().from(authIdentities).where(eq(authIdentities.userId, userId)),
    ).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
    const [t] = await db.select().from(identityTombstones);
    expect(t).toMatchObject({
      provider: 'telegram',
      isBanned: false,
      subjectHash: subjectHash('telegram', '777', deps.env.IDENTITY_PEPPER),
    });
    expect((await call('get', '/api/me', cookie)).status).toBe(401);
    const again = await resolveLogin(deps, ident);
    expect(again.isNew).toBe(true);
    expect(again.userId).not.toBe(userId);
  });

  it('deleting a banned user keeps the ban on the identity', async () => {
    const { userId } = await resolveLogin(deps, ident);
    await db
      .update(users)
      .set({ status: 'active', nickname: 'Hero', isBanned: true })
      .where(eq(users.id, userId));
    await deleteAccount(deps, userId);
    const [t] = await db.select().from(identityTombstones);
    expect(t!.isBanned).toBe(true);
    await expect(resolveLogin(deps, ident)).rejects.toMatchObject({ code: 'IDENTITY_BANNED' });
  });

  it('revokes DB sessions even if the Redis usess: set is gone', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const { token } = await createSession(deps, u.id, {});
    const hash = hashToken(token);
    const cookie = `nri_sid=${token}; nri_csrf=t`;
    expect((await call('get', '/api/me', cookie)).status).toBe(200); // кеш sess:<hash>
    await redis.del(`usess:${u.id}`);
    expect(await redis.exists(`sess:${hash}`)).toBe(1);
    await deleteAccount(deps, u.id);
    expect(await redis.exists(`revoked:${hash}`)).toBe(1);
    expect(await redis.exists(`sess:${hash}`)).toBe(0);
    expect((await call('get', '/api/me', cookie)).status).toBe(401);
  });

  it('owner cannot self-delete: 409 OWNER_CANNOT_DELETE', async () => {
    const u = await createUser(db, { nickname: 'Boss', role: 'owner' });
    const res = await call('delete', '/api/me', await login(u.id));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWNER_CANNOT_DELETE');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.status).toBe('active');
  });

  it('re-deleting an identity keeps an earlier ban', async () => {
    const hash = subjectHash('telegram', '777', deps.env.IDENTITY_PEPPER);
    await db
      .insert(identityTombstones)
      .values({ provider: 'telegram', subjectHash: hash, isBanned: true });
    const u = await createUser(db, { nickname: 'Hero' });
    await db.insert(authIdentities).values({ userId: u.id, provider: 'telegram', subject: '777' });
    await deleteAccount(deps, u.id);
    const rows = await db.select().from(identityTombstones);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isBanned).toBe(true);
  });
});
