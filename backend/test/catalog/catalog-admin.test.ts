import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { CatalogDto } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { CATALOG_CACHE_KEY } from '../../src/catalog/catalog.service.js';
import { gameSystems, games, genres, moderationLog, users } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, validGame, call } = harness(deps, app);

const BASE = '/api/admin/catalog/systems';

async function staff(role: 'moderator' | 'admin' | 'owner') {
  const u = await userWithAge(30, `${role}${Math.random().toString(36).slice(2, 7)}`);
  await db.update(users).set({ role }).where(eq(users.id, u.id));
  return u;
}

async function genreId(slug: string): Promise<number> {
  const [g] = await db.select({ id: genres.id }).from(genres).where(eq(genres.slug, slug));
  return g!.id;
}

// Каталог — сид міграції, `resetDb` його не чистить: відновлюємо вихідні рядки після кожного тесту.
const seeded = await db.select().from(gameSystems);

async function cleanup() {
  await resetDb(db);
  await db.delete(gameSystems).where(like(gameSystems.slug, 'test-%'));
  for (const { id, ...row } of seeded) {
    await db.update(gameSystems).set(row).where(eq(gameSystems.id, id));
  }
}

beforeEach(async () => {
  await redis.flushdb();
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

describe('admin catalog: permissions', () => {
  it('moderator → 403, anonymous → 401, admin and owner allowed', async () => {
    const mod = await staff('moderator');
    expect((await call('get', BASE, mod.cookie)).status).toBe(403);
    const created = await call('post', BASE, mod.cookie, {
      name: 'X',
      slug: 'test-x',
      defaultGenreId: await genreId('fantasy'),
    });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('MODERATION_FORBIDDEN');
    expect((await call('get', BASE)).status).toBe(401);
    expect((await call('get', BASE, (await staff('admin')).cookie)).status).toBe(200);
    expect((await call('get', BASE, (await staff('owner')).cookie)).status).toBe(200);
  });

  it('role demoted in DB is re-checked (session cache is not trusted for writes)', async () => {
    const admin = await staff('admin');
    await call('get', BASE, admin.cookie); // прогріває кеш сесії з роллю admin
    await db.update(users).set({ role: 'moderator' }).where(eq(users.id, admin.id));
    const res = await call('post', BASE, admin.cookie, {
      name: 'X',
      slug: 'test-x',
      defaultGenreId: await genreId('fantasy'),
    });
    expect(res.status).toBe(403);
  });
});

describe('admin catalog: list/create/patch', () => {
  it('lists all systems incl. inactive with isActive and sort', async () => {
    const admin = await staff('admin');
    await db.update(gameSystems).set({ isActive: false }).where(eq(gameSystems.slug, 'uesrpg'));
    const res = await call('get', BASE, admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(14);
    const ues = res.body.items.find((s: { slug: string }) => s.slug === 'uesrpg');
    expect(ues).toMatchObject({
      isActive: false,
      sort: expect.any(Number),
      name: expect.any(String),
    });
  });

  it('creates a system, writes log, invalidates the public catalog cache', async () => {
    const admin = await staff('admin');
    const before = (await call('get', '/api/catalog')).body as CatalogDto;
    expect(await redis.get(CATALOG_CACHE_KEY)).not.toBeNull();
    const horror = await genreId('horror');
    const res = await call('post', BASE, admin.cookie, {
      name: '  Test System  ',
      slug: 'test-sys',
      defaultGenreId: horror,
      sort: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      slug: 'test-sys',
      name: 'Test System',
      defaultGenreId: horror,
      sort: 5,
      isActive: true,
    });
    expect(await redis.get(CATALOG_CACHE_KEY)).toBeNull();
    const after = (await call('get', '/api/catalog')).body as CatalogDto;
    expect(after.systems).toHaveLength(before.systems.length + 1);
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({
      actorId: admin.id,
      action: 'catalog.system_create',
      targetType: 'game_system',
      targetId: res.body.id,
    });
  });

  it('duplicate slug → 409 CATALOG_SLUG_TAKEN', async () => {
    const admin = await staff('admin');
    const res = await call('post', BASE, admin.cookie, {
      name: 'Dup',
      slug: 'uesrpg',
      defaultGenreId: await genreId('fantasy'),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CATALOG_SLUG_TAKEN');
    expect(await db.select().from(moderationLog)).toHaveLength(0);
  });

  it.each([
    { name: 'Bad', slug: 'Bad Slug' },
    { name: 'Bad', slug: 'test--x' },
    { name: 'Bad', slug: '-test' },
    { name: 'x'.repeat(81), slug: 'test-long' },
    { name: '   ', slug: 'test-blank' },
    { name: 'Ok', slug: `test-${'a'.repeat(40)}` },
  ])('rejects invalid input %o → 400', async (body) => {
    const admin = await staff('admin');
    const res = await call('post', BASE, admin.cookie, {
      ...body,
      defaultGenreId: await genreId('fantasy'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('unknown genre → 400 UNKNOWN_GENRE (create and patch)', async () => {
    const admin = await staff('admin');
    const res = await call('post', BASE, admin.cookie, {
      name: 'X',
      slug: 'test-x',
      defaultGenreId: 999_999,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'UNKNOWN_GENRE' },
    });
    const [s] = await db.select().from(gameSystems).limit(1);
    const p = await call('patch', `${BASE}/${s!.id}`, admin.cookie, { defaultGenreId: 999_999 });
    expect(p.status).toBe(400);
    expect(p.body.error.details).toEqual({ reason: 'UNKNOWN_GENRE' });
  });

  it('patches name/genre/sort/isActive, logs changes, invalidates cache', async () => {
    const admin = await staff('admin');
    const [s] = await db.select().from(gameSystems).where(eq(gameSystems.slug, 'uesrpg'));
    await call('get', '/api/catalog');
    const scifi = await genreId('scifi');
    const res = await call('patch', `${BASE}/${s!.id}`, admin.cookie, {
      name: 'Renamed',
      defaultGenreId: scifi,
      sort: 99,
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: s!.id,
      slug: 'uesrpg',
      name: 'Renamed',
      defaultGenreId: scifi,
      sort: 99,
      isActive: false,
    });
    expect(await redis.get(CATALOG_CACHE_KEY)).toBeNull();
    const pub = (await call('get', '/api/catalog')).body as CatalogDto;
    expect(pub.systems.map((x) => x.slug)).not.toContain('uesrpg');
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({
      actorId: admin.id,
      action: 'catalog.system_update',
      targetType: 'game_system',
      targetId: s!.id,
    });
    expect(log!.meta).toMatchObject({
      before: { name: s!.name, isActive: true },
      after: { name: 'Renamed', isActive: false, sort: 99, defaultGenreId: scifi },
    });
  });

  it('patch: unknown or malformed id → 404, slug is not patchable, empty patch → 400', async () => {
    const admin = await staff('admin');
    expect((await call('patch', `${BASE}/999999`, admin.cookie, { name: 'X' })).status).toBe(404);
    const [s] = await db.select().from(gameSystems).limit(1);
    expect((await call('patch', `${BASE}/${s!.id}`, admin.cookie, { slug: 'test-x' })).status).toBe(
      400,
    );
    expect((await call('patch', `${BASE}/${s!.id}`, admin.cookie, {})).status).toBe(400);
    expect((await call('patch', `${BASE}/abc`, admin.cookie, { name: 'X' })).status).toBe(404);
  });
});

describe('inactive system in games (RF 5)', () => {
  async function systemBySlug(slug: string) {
    const [s] = await db.select().from(gameSystems).where(eq(gameSystems.slug, slug));
    return s!;
  }

  it('inactive system is rejected for a new game', async () => {
    const gm = await userWithAge(30);
    const s = await systemBySlug('uesrpg');
    await db.update(gameSystems).set({ isActive: false }).where(eq(gameSystems.id, s.id));
    const res = await call('post', '/api/games', gm.cookie, await validGame({ systemId: s.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ reason: 'UNKNOWN_SYSTEM' });
  });

  it('existing game keeps a now-inactive system, is editable and shows the system name', async () => {
    const gm = await userWithAge(30);
    const admin = await staff('admin');
    const s = await systemBySlug('uesrpg');
    const created = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({ systemId: s.id }),
    );
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    const off = await call('patch', `${BASE}/${s.id}`, admin.cookie, { isActive: false });
    expect(off.status).toBe(200);

    const edit = await call('patch', `/api/games/${id}`, gm.cookie, { title: 'Новий заголовок' });
    expect(edit.status).toBe(200);
    expect(edit.body.title).toBe('Новий заголовок');
    expect(edit.body.system).toEqual({ id: s.id, name: s.name });
    const view = await call('get', `/api/games/${id}`, gm.cookie);
    expect(view.status).toBe(200);
    expect(view.body.system).toEqual({ id: s.id, name: s.name });
    const [row] = await db.select().from(games).where(eq(games.id, id));
    expect(row!.systemId).toBe(s.id);
  });

  it('switching an existing game to an inactive system is rejected', async () => {
    const gm = await userWithAge(30);
    const a = await systemBySlug('uesrpg');
    const b = await systemBySlug('coc7e');
    const created = await call(
      'post',
      '/api/games',
      gm.cookie,
      await validGame({ systemId: a.id }),
    );
    const id = created.body.id as number;
    await db.update(gameSystems).set({ isActive: false }).where(eq(gameSystems.id, b.id));
    const res = await call('patch', `/api/games/${id}`, gm.cookie, { systemId: b.id });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ reason: 'UNKNOWN_SYSTEM' });
  });
});
