import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { resolveLogin, subjectHash } from '../../src/auth/identity.service.js';
import { createSession, hashToken } from '../../src/auth/session.service.js';
import {
  authIdentities,
  availabilityBusyDates,
  availabilitySlots,
  events,
  gameApplications,
  gameMembers,
  games,
  gameSystems,
  genres,
  identityTombstones,
  sessions,
  userProfiles,
  users,
} from '../../src/db/schema/index.js';
import { changeBirthDate, completeProfile, deleteAccount } from '../../src/users/users.service.js';
import { ageOn, localDate } from '@nri/shared';
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

/**
 * Дата народження `y` років тому (+`dayOffset` діб) від СЬОГОДНІШНЬОЇ дати в поясі акаунта
 * (Europe/Kyiv — пояс тестових користувачів), як рахує бекенд, а не від дати UTC: інакше
 * о 22:00–24:00 UTC вік виходив би на день «старшим».
 */
const yearsAgo = (y: number, dayOffset = 0): string => {
  const d = new Date(`${localDate(new Date(), 'Europe/Kyiv')}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};

describe('yearsAgo helper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds dates in the account zone (Kyiv), not UTC — 23:30 UTC is already tomorrow', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T23:30:00Z') });
    const today = localDate(new Date(), 'Europe/Kyiv');
    expect(today).toBe('2026-11-25');
    expect(ageOn(yearsAgo(14, 1), today)).toBe(13);
    expect(ageOn(yearsAgo(14), today)).toBe(14);
  });
});

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
      publicId: u.publicId,
      nickname: 'Hero',
      avatarUrl: null,
      birthDate: '2000-01-01',
      role: 'user',
      status: 'active',
      timezone: 'Europe/Kyiv',
      locale: 'uk',
      identities: [{ provider: 'google', displayName: 'G' }],
      uiTheme: 'quest-board',
      availableThemes: [
        'quest-board',
        'neon-signs',
        'holo-market',
        'night-city',
        'dungeon',
        'gothic-gloom',
      ],
      uiPrefs: { tearAnimation: true },
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

describe('PATCH /api/me/timezone', () => {
  it('validates and updates the account timezone; slots keep their wall-clock times', async () => {
    const u = await createUser(db, { nickname: 'Tz', timezone: 'Europe/Kyiv' });
    const cookie = await login(u.id);
    await db
      .insert(availabilitySlots)
      .values({ userId: u.id, weekday: 1, startMin: 19 * 60, endMin: 23 * 60 });

    const res = await call('patch', '/api/me/timezone', cookie, { timezone: 'America/New_York' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: u.id,
      publicId: u.publicId,
      timezone: 'America/New_York',
    });
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.timezone).toBe('America/New_York');
    expect((await call('get', '/api/me', cookie)).body.timezone).toBe('America/New_York');

    const cal = (await call('get', '/api/me/availability', cookie)).body;
    expect(cal).toEqual({
      timezone: 'America/New_York',
      slots: [{ weekday: 1, startMin: 19 * 60, endMin: 23 * 60 }],
      busyDates: [],
    });
    const [e] = await db.select().from(events).where(eq(events.type, 'user.timezone_changed'));
    expect(e!.payload).toEqual({ from: 'Europe/Kyiv', to: 'America/New_York' });
  });

  it('400 for an invalid zone or extra keys; 401 without a session; 403 for pending', async () => {
    const u = await createUser(db, { nickname: 'Tz', timezone: 'Europe/Kyiv' });
    const cookie = await login(u.id);
    for (const body of [
      {},
      { timezone: 'Nope/Zone' },
      { timezone: 'UTC', extra: 1 },
      { timezone: 'Europe/Moscow' },
      { timezone: 'Asia/Vladivostok' },
    ]) {
      const res = await call('patch', '/api/me/timezone', cookie, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    }
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.timezone).toBe('Europe/Kyiv');
    const guest = await request(app)
      .patch('/api/me/timezone')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't')
      .send({ timezone: 'UTC' });
    expect(guest.status).toBe(401);
    const p = await createUser(db, { status: 'pending' });
    const res = await call('patch', '/api/me/timezone', await login(p.id), { timezone: 'UTC' });
    expect(res.status).toBe(403);
  });
  it('Europe/Kiev is saved as Europe/Kyiv; Simferopol is allowed', async () => {
    const u = await createUser(db, { nickname: 'Tz', timezone: 'Europe/Warsaw' });
    const cookie = await login(u.id);
    const res = await call('patch', '/api/me/timezone', cookie, { timezone: 'Europe/Kiev' });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('Europe/Kyiv');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.timezone).toBe('Europe/Kyiv');
    const sim = await call('patch', '/api/me/timezone', cookie, {
      timezone: 'Europe/Simferopol',
    });
    expect(sim.status).toBe(200);
  });
});

describe('PATCH /api/me/ui-prefs', () => {
  it('saves tearAnimation; /api/me returns it (default true)', async () => {
    const u = await createUser(db, { nickname: 'Prefs' });
    const cookie = await login(u.id);
    expect((await call('get', '/api/me', cookie)).body.uiPrefs).toEqual({ tearAnimation: true });
    const res = await call('patch', '/api/me/ui-prefs', cookie, { tearAnimation: false });
    expect(res.status).toBe(200);
    expect(res.body.uiPrefs).toEqual({ tearAnimation: false });
    expect((await call('get', '/api/me', cookie)).body.uiPrefs).toEqual({ tearAnimation: false });
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.qbTearAnimation).toBe(false);
  });

  it('strict body: missing, non-boolean or extra keys → 400', async () => {
    const u = await createUser(db, { nickname: 'Prefs2' });
    const cookie = await login(u.id);
    for (const body of [{}, { tearAnimation: 'no' }, { tearAnimation: true, extra: 1 }]) {
      const bad = await call('patch', '/api/me/ui-prefs', cookie, body);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION');
    }
  });

  it('guest: 401; pending account: 403', async () => {
    const guest = await request(app)
      .patch('/api/me/ui-prefs')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't')
      .send({ tearAnimation: false });
    expect(guest.status).toBe(401);
    const p = await createUser(db, { status: 'pending' });
    const res = await call('patch', '/api/me/ui-prefs', await login(p.id), {
      tearAnimation: false,
    });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/me/theme', () => {
  const ALL_THEMES = [
    'quest-board',
    'neon-signs',
    'holo-market',
    'night-city',
    'dungeon',
    'gothic-gloom',
  ];

  it('a regular user picks a cyber design; /api/me returns it; defaults to quest-board', async () => {
    const u = await createUser(db, { nickname: 'Usr' });
    const cookie = await login(u.id);
    const before = (await call('get', '/api/me', cookie)).body;
    expect(before).toMatchObject({ uiTheme: 'quest-board', availableThemes: ALL_THEMES });
    const res = await call('patch', '/api/me/theme', cookie, { theme: 'night-city' });
    expect(res.status).toBe(200);
    expect(res.body.uiTheme).toBe('night-city');
    expect((await call('get', '/api/me', cookie)).body.uiTheme).toBe('night-city');
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.uiTheme).toBe('night-city');
  });

  it('Plan 10: «dungeon» is accepted for a regular user', async () => {
    const u = await createUser(db, { nickname: 'Dungeon' });
    const res = await call('patch', '/api/me/theme', await login(u.id), { theme: 'dungeon' });
    expect(res.status).toBe(200);
    expect(res.body.uiTheme).toBe('dungeon');
  });

  it('Plan 10: «gothic-gloom» is accepted for a regular user', async () => {
    const u = await createUser(db, { nickname: 'Gothic' });
    const res = await call('patch', '/api/me/theme', await login(u.id), { theme: 'gothic-gloom' });
    expect(res.status).toBe(200);
    expect(res.body.uiTheme).toBe('gothic-gloom');
  });

  it('removed «classic», unknown id or extra keys: 400', async () => {
    const u = await createUser(db, { nickname: 'Usr2' });
    const cookie = await login(u.id);
    for (const body of [
      { theme: 'classic' },
      { theme: 'bogus' },
      {},
      { theme: 'quest-board', extra: 1 },
    ]) {
      const bad = await call('patch', '/api/me/theme', cookie, body);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION');
    }
    const ok = await call('patch', '/api/me/theme', cookie, { theme: 'neon-signs' });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row!.uiTheme).toBe('neon-signs');
  });

  it('guest: 401', async () => {
    const guest = await request(app)
      .patch('/api/me/theme')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't')
      .send({ theme: 'quest-board' });
    expect(guest.status).toBe(401);
  });

  it('RF 1: a stored legacy «classic» resolves to quest-board; the DB value stays', async () => {
    const owner = await createUser(db, { nickname: 'Boss', role: 'owner' });
    await db.update(users).set({ uiTheme: 'classic' }).where(eq(users.id, owner.id));
    const cookie = await login(owner.id);
    expect((await call('get', '/api/me', cookie)).body).toMatchObject({
      role: 'owner',
      uiTheme: 'quest-board',
      availableThemes: ALL_THEMES,
    });
    const [row] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(row!.uiTheme).toBe('classic');
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

  async function insertGame(
    gmUserId: number,
    patch: Partial<typeof games.$inferInsert> = {},
  ): Promise<number> {
    const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
    const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
    const [r] = await db
      .insert(games)
      .values({
        gmUserId,
        title: 'Гра',
        description: '',
        systemId: sys!.id,
        genreId: gen!.id,
        format: 'online',
        kind: 'campaign',
        startsAt: new Date(Date.now() + 30 * 86_400_000),
        durationMinutes: 240,
        recurrence: 'none',
        weekdays: [],
        timezone: 'Europe/Kyiv',
        minPlayers: 1,
        maxPlayers: 5,
        status: 'recruiting',
        publishedAt: new Date(),
        ...patch,
      })
      .$returningId();
    return r!.id;
  }

  it('removes profile and availability, ends active memberships (no FK cascade on a tombstone)', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const other = await createUser(db, { nickname: 'Other' });
    const theirGame = await insertGame(other.id);
    const startedGame = await insertGame(other.id, { status: 'started' });
    const finishedGame = await insertGame(other.id, { status: 'finished' });
    const cancelledGame = await insertGame(other.id, { status: 'cancelled' });
    await db.insert(gameMembers).values([
      { gameId: startedGame, userId: u.id },
      { gameId: finishedGame, userId: u.id },
      { gameId: cancelledGame, userId: u.id },
    ]);
    await db.insert(userProfiles).values({ userId: u.id, bio: 'secret bio', city: 'Київ' });
    await db
      .insert(availabilitySlots)
      .values({ userId: u.id, weekday: 1, startMin: 0, endMin: 60 });
    await db.insert(availabilityBusyDates).values({ userId: u.id, date: '2030-01-01' });
    await db.insert(gameMembers).values({ gameId: theirGame, userId: u.id });
    await deleteAccount(deps, u.id);
    expect(await db.select().from(userProfiles).where(eq(userProfiles.userId, u.id))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(availabilitySlots).where(eq(availabilitySlots.userId, u.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(availabilityBusyDates).where(eq(availabilityBusyDates.userId, u.id)),
    ).toHaveLength(0);
    // Активні ігри покинуто (членство завершено, не видалено — історія присутності);
    // склад завершених/скасованих (історія інших) не змінюється.
    const rows = await db.select().from(gameMembers).where(eq(gameMembers.userId, u.id));
    const byGame = new Map(rows.map((m) => [m.gameId, m]));
    expect(rows).toHaveLength(4);
    for (const gid of [theirGame, startedGame]) {
      expect(byGame.get(gid)!.leftAt).not.toBeNull();
      expect(byGame.get(gid)!.leftReason).toBe('account_deleted');
    }
    for (const gid of [finishedGame, cancelledGame]) {
      expect(byGame.get(gid)!.leftAt).toBeNull();
      expect(byGame.get(gid)!.leftReason).toBeNull();
    }
    // Чужа гра не зачеплена.
    const [g] = await db.select().from(games).where(eq(games.id, theirGame));
    expect(g!.status).toBe('recruiting');
  });

  it('withdraws the pending applications of the deleted user (no FK cascade on a tombstone)', async () => {
    const u = await createUser(db, { nickname: 'Applicant' });
    const other = await createUser(db, { nickname: 'Gm2' });
    const g1 = await insertGame(other.id);
    const g2 = await insertGame(other.id);
    const base = { answers: [], constraints: [], warningsAcceptedAt: new Date() };
    await db.insert(gameApplications).values([
      { ...base, gameId: g1, userId: u.id },
      { ...base, gameId: g2, userId: u.id, status: 'rejected' },
    ]);
    await deleteAccount(deps, u.id);
    const rows = await db.select().from(gameApplications).where(eq(gameApplications.userId, u.id));
    const byGame = new Map(rows.map((r) => [r.gameId, r.status]));
    expect(byGame.get(g1)).toBe('withdrawn');
    expect(byGame.get(g2)).toBe('rejected');
    const ev = await db.select().from(events).where(eq(events.type, 'application.withdrawn'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ userId: u.id, entityType: 'application' });
    expect(ev[0]!.payload).toMatchObject({ gameId: g1 });
  });

  it('ends an already-left membership only once (keeps the original left reason)', async () => {
    const u = await createUser(db, { nickname: 'Hero' });
    const other = await createUser(db, { nickname: 'Other' });
    const g = await insertGame(other.id);
    const leftAt = new Date(Date.now() - 86_400_000);
    leftAt.setMilliseconds(0);
    await db.insert(gameMembers).values({ gameId: g, userId: u.id, leftAt, leftReason: 'kicked' });
    await deleteAccount(deps, u.id);
    const [m] = await db.select().from(gameMembers).where(eq(gameMembers.userId, u.id));
    expect(m).toMatchObject({ leftReason: 'kicked', leftAt });
  });

  it('two users deleting at once with cross pending applications: no deadlock', async () => {
    const base = { answers: [], constraints: [], warningsAcceptedAt: new Date() };
    for (let i = 0; i < 5; i++) {
      await resetDb(db);
      const a = await createUser(db, { nickname: 'Aaa' });
      const b = await createUser(db, { nickname: 'Bbb' });
      const ga = await insertGame(a.id);
      const gb = await insertGame(b.id);
      await db.insert(gameApplications).values([
        { ...base, gameId: gb, userId: a.id },
        { ...base, gameId: ga, userId: b.id },
      ]);
      const res = await Promise.allSettled([deleteAccount(deps, a.id), deleteAccount(deps, b.id)]);
      expect(res.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok'))).toEqual([
        'ok',
        'ok',
      ]);
      const apps = await db.select().from(gameApplications);
      expect(apps.every((x) => x.status !== 'pending')).toBe(true);
    }
  }, 30_000);

  it("cancels pending applications to the deleted GM's games", async () => {
    const gm = await createUser(db, { nickname: 'GoneGm' });
    const p = await createUser(db, { nickname: 'P' });
    const g = await insertGame(gm.id);
    await db.insert(gameApplications).values({
      gameId: g,
      userId: p.id,
      answers: [],
      constraints: [],
      warningsAcceptedAt: new Date(),
    });
    await deleteAccount(deps, gm.id);
    const [row] = await db.select().from(gameApplications).where(eq(gameApplications.gameId, g));
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'game_cancelled' });
  });

  it("cancels the GM's active games; they leave search and the sitemap (R8)", async () => {
    const u = await createUser(db, { nickname: 'Gm' });
    const recruiting = await insertGame(u.id);
    const started = await insertGame(u.id, { status: 'started', showWhenFull: true });
    const draft = await insertGame(u.id, { status: 'draft', publishedAt: null });
    const finished = await insertGame(u.id, { status: 'finished' });
    const before = await request(app)
      .post('/api/games/search')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't')
      .send({});
    expect(before.body.items.map((i: { id: number }) => i.id).sort()).toEqual(
      [recruiting, started].sort(),
    );
    await deleteAccount(deps, u.id);
    const rows = await db.select().from(games).where(eq(games.gmUserId, u.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [recruiting, started, draft]) {
      expect(byId.get(id)!.status).toBe('cancelled');
      expect(byId.get(id)!.cancelledAt).not.toBeNull();
    }
    expect(byId.get(finished)!.status).toBe('finished');
    const ev = await db
      .select()
      .from(events)
      .where(and(eq(events.type, 'game.cancelled'), eq(events.userId, u.id)));
    expect(ev.map((e) => e.entityId).sort()).toEqual([recruiting, started, draft].sort());
    for (const e of ev) expect(e.payload).toMatchObject({ reason: 'account_deleted' });

    const after = await request(app)
      .post('/api/games/search')
      .set('Cookie', 'nri_csrf=t')
      .set('X-CSRF-Token', 't')
      .send({});
    expect(after.body.items).toHaveLength(0);
    await redis.del('seo:sitemap');
    const sitemap = await request(app).get('/sitemap.xml');
    for (const id of [recruiting, started]) expect(sitemap.text).not.toContain(`/games/${id}<`);
  });
});
