import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { games, gameSystems, genres, userProfiles } from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { bornYearsAgo } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const BASE = deps.env.PUBLIC_BASE_URL;

let gmId = 0;
beforeEach(async () => {
  gmId = 0;
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

async function insertGame(patch: Partial<typeof games.$inferInsert> = {}): Promise<number> {
  if (!gmId) gmId = (await createUser(db, { nickname: 'Gm' })).id;
  const [s] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [g] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [r] = await db
    .insert(games)
    .values({
      gmUserId: gmId,
      title: 'Гра',
      description: 'Опис гри',
      systemId: s!.id,
      genreId: g!.id,
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

describe('sitemap.xml / robots.txt', () => {
  it('lists public games and active profiles only', async () => {
    const open = await insertGame();
    const started = await insertGame({ status: 'started' });
    const adult = await insertGame({ ageRating: '18+' });
    const draft = await insertGame({ status: 'draft' });
    const done = await insertGame({ status: 'finished' });
    const del = await createUser(db, { status: 'deleted' });
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.text).toContain(`<loc>${BASE}/games/${open}</loc>`);
    expect(res.text).toContain(`<loc>${BASE}/games/${started}</loc>`);
    expect(res.text).toContain(`<loc>${BASE}/about</loc>`);
    expect(res.text).toContain('<lastmod>');
    for (const id of [adult, draft, done]) expect(res.text).not.toContain(`/games/${id}<`);
    expect(res.text).not.toContain(del.publicId);
    const gm = await db.query.users.findFirst();
    expect(res.text).toContain(`${BASE}/users/${gm!.publicId}<`);
  });

  it('past one-shots are not listed; running campaigns are', async () => {
    const past = await insertGame({ startsAt: new Date(Date.now() - 86_400_000) });
    const running = await insertGame({
      recurrence: 'weekly',
      weekdays: [0],
      startsAt: new Date(Date.now() - 14 * 86_400_000),
    });
    const res = await request(app).get('/sitemap.xml');
    expect(res.text).not.toContain(`/games/${past}<`);
    expect(res.text).toContain(`/games/${running}<`);
    const og = await request(app).get(`/api/og/games/${past}`);
    expect(og.text).toContain('<meta name="robots" content="noindex">');
  });

  it('robots.txt points to the sitemap', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(res.text).toContain('Disallow: /api/');
    expect(res.text).toContain('Disallow: /account');
    expect(res.text).toContain('Allow: /');
  });
});

describe('dev environment indexing', () => {
  it('sends noindex headers and Disallow: / on dev only', async () => {
    const devApp = createApp({ ...deps, env: { ...deps.env, DEPLOY_ENV: 'dev' } });
    const robots = await request(devApp).get('/robots.txt');
    expect(robots.text).toContain('Disallow: /\n');
    expect(robots.text).not.toContain('Allow: /\n');
    expect(robots.text).not.toContain('Sitemap');
    expect(robots.headers['x-robots-tag']).toBe('noindex, nofollow');
    const health = await request(devApp).get('/api/health/live');
    expect(health.headers['x-robots-tag']).toBe('noindex, nofollow');

    const prodApp = createApp({ ...deps, env: { ...deps.env, DEPLOY_ENV: 'prod' } });
    expect((await request(prodApp).get('/robots.txt')).headers['x-robots-tag']).toBeUndefined();
    expect((await request(app).get('/api/health/live')).headers['x-robots-tag']).toBeUndefined();
  });
});

describe('og previews', () => {
  it('escapes game title and builds og tags', async () => {
    const id = await insertGame({
      title: '<script>alert("x")</script>&',
      coverUrl: 'https://img.example/a.png?x=1&y="2"',
    });
    const res = await request(app).get(`/api/og/games/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain(`<meta property="og:url" content="${BASE}/games/${id}">`);
    expect(res.text).toContain('og:type" content="website"');
    expect(res.text).toContain('twitter:card');
    expect(res.text).toContain('og:description');
    expect(res.text).toContain('&quot;2&quot;');
    expect(res.text).not.toContain('noindex');
  });

  it('truncates long descriptions to 200 chars on a word boundary', async () => {
    const id = await insertGame({ description: 'слово '.repeat(100) });
    const res = await request(app).get(`/api/og/games/${id}`);
    const m = /og:description" content="([^"]*)"/.exec(res.text)!;
    expect(m[1]!.length).toBeLessThanOrEqual(200);
    expect(m[1]!.endsWith('слово…')).toBe(true);
  });

  it('18+ games, drafts and cancelled get neutral meta with noindex', async () => {
    const adult = await insertGame({ ageRating: '18+', title: 'Секрет', description: 'таємниця' });
    const draft = await insertGame({ status: 'draft', title: 'Чернетка', description: 'таємниця' });
    const cancelled = await insertGame({ status: 'cancelled', description: 'таємниця' });
    for (const id of [adult, draft, cancelled]) {
      const res = await request(app).get(`/api/og/games/${id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<meta name="robots" content="noindex">');
      expect(res.text).not.toContain('таємниця');
      expect(res.text).not.toContain('Секрет');
      expect(res.text).not.toContain('Чернетка');
      expect(res.text).not.toContain('og:description');
    }
  });

  it('unknown game → 404 noindex', async () => {
    const res = await request(app).get('/api/og/games/999999');
    expect(res.status).toBe(404);
    expect(res.text).toContain('noindex');
  });

  it('user profile og; deleted user neutral', async () => {
    const u = await createUser(db, {
      nickname: 'Orc<b>',
      avatarUrl: 'https://img.example/u.png',
      birthDate: bornYearsAgo(30),
    });
    await db.insert(userProfiles).values({ userId: u.id, bio: 'Люблю <i>ігри</i>' });
    const res = await request(app).get(`/api/og/users/${u.publicId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:type" content="profile"');
    expect(res.text).toContain(`${BASE}/users/${u.publicId}`);
    expect(res.text).toContain('Orc&lt;b&gt;');
    expect(res.text).toContain('Люблю &lt;i&gt;ігри&lt;/i&gt;');
    expect(res.text).toContain('https://img.example/u.png');

    const d = await createUser(db, { status: 'deleted', nickname: 'Ghost' });
    const del = await request(app).get(`/api/og/users/${d.publicId}`);
    expect(del.text).toContain('noindex');
    expect(del.text).not.toContain('Ghost');
  });

  it('hidden bio is not exposed; non-https avatar skipped', async () => {
    const u = await createUser(db, { nickname: 'Shy', avatarUrl: 'http://x.example/a.png' });
    await db
      .insert(userProfiles)
      .values({ userId: u.id, bio: 'приховано', privacy: { bio: false } });
    const res = await request(app).get(`/api/og/users/${u.publicId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('приховано');
    expect(res.text).not.toContain('og:description');
    expect(res.text).not.toContain('og:image');
  });

  it('banned user is neutral + noindex; pending is 404', async () => {
    const b = await createUser(db, { nickname: 'Banned', isBanned: true });
    const res = await request(app).get(`/api/og/users/${b.publicId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('noindex');
    expect(res.text).not.toContain('Banned');
    const p = await createUser(db, { status: 'pending' });
    expect((await request(app).get(`/api/og/users/${p.publicId}`)).status).toBe(404);
  });
});
