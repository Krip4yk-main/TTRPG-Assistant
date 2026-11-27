import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { linkIdentity, resolveLogin } from '../../src/auth/identity.service.js';
import { createSession } from '../../src/auth/session.service.js';
import { authIdentities, users } from '../../src/db/schema/index.js';
import { ImageUrlError } from '../../src/http/image-url.js';
import { deleteAccount } from '../../src/users/users.service.js';
import { effectiveAvatar } from '../../src/users/avatar.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';

/** Фейкова перевірка: мережі в тестах немає; `bad-<reason>` у шляху → відповідна помилка. */
const checked: string[] = [];
const deps = {
  ...(await testDeps()),
  imageUrlChecker: async (url: string) => {
    checked.push(url);
    const m = /bad-(\w+)/.exec(url);
    if (m) throw new ImageUrlError(m[1] as never);
  },
};
const { db, redis } = deps;
const app = createApp(deps);

beforeEach(async () => {
  checked.length = 0;
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const TG = 'https://t.me/i/userpic/a.jpg';
const GOOGLE = 'https://lh3.example.com/g.jpg';
const tg = (avatarUrl?: string | null) =>
  ({ provider: 'telegram', subject: '1', avatarUrl }) as const;
const google = (avatarUrl?: string | null) =>
  ({ provider: 'google', subject: 'g1', avatarUrl }) as const;

const userRow = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0]!;
async function activeUser(avatarUrl?: string) {
  const { userId } = await resolveLogin(deps, tg(avatarUrl));
  await db
    .update(users)
    .set({ status: 'active', nickname: `u${userId}` })
    .where(eq(users.id, userId));
  const { token } = await createSession(deps, userId, {});
  return { userId, cookie: `nri_sid=${token}; nri_csrf=t` };
}
const put = (cookie: string, body: object) =>
  request(app).put('/api/me/avatar').set('Cookie', cookie).set('X-CSRF-Token', 't').send(body);
const getMe = (cookie: string) => request(app).get('/api/me').set('Cookie', cookie);

describe('effectiveAvatar', () => {
  const ids = [
    { provider: 'telegram', avatarUrl: null },
    { provider: 'google', avatarUrl: GOOGLE },
  ] as const;
  it('auto: creation provider first, else any linked with avatar', () => {
    expect(effectiveAvatar('auto', null, ids)).toBe(GOOGLE);
    expect(
      effectiveAvatar('auto', null, [{ provider: 'telegram', avatarUrl: TG }, ...ids.slice(1)]),
    ).toBe(TG);
    expect(effectiveAvatar('auto', null, [])).toBeNull();
  });
  it('none / custom / provider with fallback to auto', () => {
    expect(effectiveAvatar('none', 'https://c/x.png', ids)).toBeNull();
    expect(effectiveAvatar('custom', 'https://c/x.png', ids)).toBe('https://c/x.png');
    expect(effectiveAvatar('google', null, ids)).toBe(GOOGLE);
    expect(effectiveAvatar('telegram', null, ids)).toBe(GOOGLE);
  });
});

describe('avatar refresh on login / link', () => {
  it('stores identity avatar at creation and refreshes it on every login', async () => {
    const { userId } = await resolveLogin(deps, tg(TG));
    expect((await userRow(userId)).avatarUrl).toBe(TG);
    await resolveLogin(deps, tg('https://t.me/i/userpic/new.jpg'));
    const [i] = await db.select().from(authIdentities).where(eq(authIdentities.userId, userId));
    expect(i!.avatarUrl).toBe('https://t.me/i/userpic/new.jpg');
    expect((await userRow(userId)).avatarUrl).toBe('https://t.me/i/userpic/new.jpg');
    await resolveLogin(deps, tg()); // аватар невідомий — зберігаємо
    expect((await userRow(userId)).avatarUrl).toBe('https://t.me/i/userpic/new.jpg');
    await resolveLogin(deps, tg(null)); // провайдер прибрав фото
    expect((await userRow(userId)).avatarUrl).toBeNull();
  });

  it('linking stores avatar; auto picks it up when the creation provider has none', async () => {
    const { userId } = await resolveLogin(deps, tg(null));
    expect((await userRow(userId)).avatarUrl).toBeNull();
    await linkIdentity(deps, userId, google(GOOGLE));
    expect((await userRow(userId)).avatarUrl).toBe(GOOGLE);
  });

  it('auto keeps the creation provider avatar after linking; manual choice survives login', async () => {
    const { userId, cookie } = await activeUser(TG);
    await linkIdentity(deps, userId, google(GOOGLE));
    expect((await userRow(userId)).avatarUrl).toBe(TG);
    expect((await put(cookie, { source: 'google' })).status).toBe(200);
    await resolveLogin(deps, tg('https://t.me/i/userpic/n.jpg'));
    expect((await userRow(userId)).avatarUrl).toBe(GOOGLE);
    await resolveLogin(deps, google('https://lh3.example.com/g2.jpg'));
    expect((await userRow(userId)).avatarUrl).toBe('https://lh3.example.com/g2.jpg');
  });
});

describe('PUT /api/me/avatar', () => {
  it('GET /api/me exposes source, custom url and available options', async () => {
    const { userId, cookie } = await activeUser(TG);
    await linkIdentity(deps, userId, google(GOOGLE));
    const me = (await getMe(cookie)).body;
    expect(me).toMatchObject({ avatarUrl: TG, avatarSource: 'auto', customAvatarUrl: null });
    expect(me.avatarOptions).toEqual([
      { source: 'telegram', previewUrl: TG },
      { source: 'google', previewUrl: GOOGLE },
    ]);
  });

  it('switches to a linked provider, none and back to auto', async () => {
    const { userId, cookie } = await activeUser(TG);
    await linkIdentity(deps, userId, google(GOOGLE));
    let res = await put(cookie, { source: 'google' });
    expect(res.body).toMatchObject({ avatarSource: 'google', avatarUrl: GOOGLE });
    res = await put(cookie, { source: 'none' });
    expect(res.body).toMatchObject({ avatarSource: 'none', avatarUrl: null });
    res = await put(cookie, { source: 'auto' });
    expect(res.body).toMatchObject({ avatarSource: 'auto', avatarUrl: TG });
  });

  it('unlinked provider or provider without avatar → 422 AVATAR_SOURCE_UNAVAILABLE', async () => {
    const { userId, cookie } = await activeUser(TG);
    let res = await put(cookie, { source: 'discord' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AVATAR_SOURCE_UNAVAILABLE');
    await linkIdentity(deps, userId, google(null));
    res = await put(cookie, { source: 'google' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AVATAR_SOURCE_UNAVAILABLE');
    expect((await userRow(userId)).avatarSource).toBe('auto');
  });

  it('custom: checked via image-url, saved; bad link → 422 IMAGE_URL_INVALID, nothing saved', async () => {
    const { userId, cookie } = await activeUser(TG);
    const url = 'https://img.example.com/me.png';
    const res = await put(cookie, { source: 'custom', customUrl: url });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      avatarSource: 'custom',
      avatarUrl: url,
      customAvatarUrl: url,
    });
    expect(checked).toEqual([url]);
    const bad = await put(cookie, {
      source: 'custom',
      customUrl: 'https://img.example.com/bad-not_image.png',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toEqual({
      code: 'IMAGE_URL_INVALID',
      details: { field: 'customUrl', reason: 'not_image' },
    });
    expect((await userRow(userId)).avatarUrl).toBe(url);
  });

  it('validates body: custom needs https customUrl, others must not have it', async () => {
    const { cookie } = await activeUser(TG);
    expect((await put(cookie, { source: 'custom' })).status).toBe(400);
    expect((await put(cookie, { source: 'custom', customUrl: 'http://x/y.png' })).status).toBe(400);
    expect((await put(cookie, { source: 'none', customUrl: 'https://x/y.png' })).status).toBe(400);
    expect((await put(cookie, { source: 'nope' })).status).toBe(400);
    expect(checked).toEqual([]);
  });

  it('customUrl checks are rate limited like cover checks', async () => {
    const { cookie } = await activeUser(TG);
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await put(cookie, {
        source: 'custom',
        customUrl: `https://img.example.com/${i}.png`,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('unlinking the chosen provider resets to auto and recomputes', async () => {
    const { userId, cookie } = await activeUser(TG);
    await linkIdentity(deps, userId, google(GOOGLE));
    await put(cookie, { source: 'google' });
    const res = await request(app)
      .delete('/api/me/identities/google')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 't');
    expect(res.status).toBe(200);
    expect(await userRow(userId)).toMatchObject({ avatarSource: 'auto', avatarUrl: TG });
  });
});

describe('deleteAccount', () => {
  it('clears avatar, source and custom url', async () => {
    const { userId, cookie } = await activeUser(TG);
    await put(cookie, { source: 'custom', customUrl: 'https://img.example.com/me.png' });
    await deleteAccount(deps, userId);
    expect(await userRow(userId)).toMatchObject({
      avatarUrl: null,
      avatarSource: 'auto',
      customAvatarUrl: null,
    });
  });
});
