import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { subjectHash } from '../../src/auth/identity.service.js';
import { createDiscordProvider } from '../../src/auth/providers/discord.js';
import { defaultOAuthProviders } from '../../src/auth/providers/index.js';
import { authIdentities, identityTombstones, sessions, users } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, TEST_PEPPER, testDeps } from '../helpers.js';
import { sign, TEST_BOT_TOKEN } from './telegram-sign.js';

/*
 * Справжній Discord-провайдер, мережа підмінена: token endpoint і users/@me — фейкові,
 * будь-який інший URL кидає помилку.
 */
const BASE_URL = 'https://nri.example';
const CLIENT_ID = '123456789';
const CLIENT_SECRET = 'discord-secret';
const REDIRECT = `${BASE_URL}/api/auth/discord/callback`;

let me: Record<string, unknown> = {};
let tokenStatus = 200;
let meStatus = 200;
let tokenRequests: { body: URLSearchParams; auth: string | null }[] = [];
let meAuth: string | null = null;

const json = (x: unknown, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  if (url === 'https://discord.com/api/v10/oauth2/token') {
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    tokenRequests.push({
      body: new URLSearchParams(String(init?.body)),
      auth: headers.get('authorization'),
    });
    if (tokenStatus !== 200) return json({ error: 'invalid_grant' }, tokenStatus);
    return json({ access_token: 'at-1', token_type: 'Bearer', expires_in: 600, scope: 'identify' });
  }
  if (url === 'https://discord.com/api/v10/users/@me') {
    meAuth = headers.get('authorization');
    if (meStatus !== 200) return json({ message: '401: Unauthorized' }, meStatus);
    return json(me);
  }
  throw new Error(`unexpected fetch ${url}`);
});

const discord = createDiscordProvider({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  publicBaseUrl: BASE_URL,
  fetch: fakeFetch as unknown as typeof fetch,
});

const base = await testDeps({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN });
const deps = { ...base, oauthProviders: { discord } };
const { db, redis } = deps;

beforeEach(async () => {
  me = { id: '80351110224678912', username: 'nelly', global_name: 'Nelly', avatar: null };
  tokenStatus = 200;
  meStatus = 200;
  tokenRequests = [];
  meAuth = null;
  fakeFetch.mockClear();
  await resetDb(db);
  await redis.flushdb();
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(base);
});

const cookies = (res: request.Response) =>
  ((res.headers['set-cookie'] ?? []) as unknown as string[]).join(';');

async function startFlow(agent: ReturnType<typeof request.agent>, qs = '') {
  const res = await agent.get(`/api/auth/discord/start${qs}`);
  const loc = res.headers.location as string;
  const state = new URL(loc, 'http://x.invalid').searchParams.get('state');
  return { res, loc, state: state! };
}

async function loggedInTelegram(app: ReturnType<typeof createApp>, id: string) {
  const agent = request.agent(app);
  const r = await agent.get('/api/health');
  const csrf = /nri_csrf=([^;]+)/.exec(cookies(r))![1]!;
  const body = sign(
    { id, first_name: 'Ada', auth_date: String(Math.floor(Date.now() / 1000)) },
    TEST_BOT_TOKEN,
  );
  const res = await agent.post('/api/auth/telegram').set('x-csrf-token', csrf).send(body);
  expect(res.status).toBe(200);
  return { agent, userId: res.body.user.id as number };
}

describe('discord provider (unit)', () => {
  it('builds authorize URL: code + PKCE S256 + state, scope identify, our redirect', async () => {
    const url = await discord.createAuthorizationUrl({
      state: 'st',
      codeVerifier: 'verifier-123',
      nonce: 'n',
    });
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('scope')).toBe('identify');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('state')).toBe('st');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe(
      createHash('sha256').update('verifier-123').digest('base64url'),
    );
    expect(p.has('client_secret')).toBe(false);
  });

  it('exchanges code with verifier + basic auth, maps users/@me', async () => {
    me = { id: '42', username: 'nick', global_name: null, avatar: 'a_' + 'f'.repeat(32) };
    const id = await discord.exchange({
      callbackParams: new URLSearchParams({ code: 'c1', state: 'st' }),
      codeVerifier: 'v1',
      state: 'st',
      nonce: 'n',
    });
    expect(id).toEqual({
      provider: 'discord',
      subject: '42',
      displayName: 'nick',
      avatarUrl: `https://cdn.discordapp.com/avatars/42/a_${'f'.repeat(32)}.png`,
    });
    const [t] = tokenRequests;
    expect(Object.fromEntries(t!.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'c1',
      redirect_uri: REDIRECT,
      code_verifier: 'v1',
    });
    expect(t!.auth).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(meAuth).toBe('Bearer at-1');
  });

  it('prefers global_name; ignores malformed avatar', async () => {
    me = { id: '43', username: 'u', global_name: 'Global', avatar: '../x' };
    const id = await discord.exchange({
      callbackParams: new URLSearchParams({ code: 'c', state: 's' }),
      codeVerifier: 'v',
      state: 's',
      nonce: 'n',
    });
    expect(id.displayName).toBe('Global');
    expect(id.avatarUrl).toBeUndefined();
  });

  it.each([
    ['state mismatch', { code: 'c', state: 'other' }, {}],
    ['missing code', { state: 's' }, {}],
    ['token endpoint error', { code: 'c', state: 's' }, { token: 400 }],
    ['users/@me error', { code: 'c', state: 's' }, { me: 401 }],
    ['users/@me without numeric id', { code: 'c', state: 's' }, { badId: true }],
  ])('rejects: %s', async (_n, params, opts: { token?: number; me?: number; badId?: boolean }) => {
    if (opts.token) tokenStatus = opts.token;
    if (opts.me) meStatus = opts.me;
    if (opts.badId) me = { id: 'abc', username: 'x' };
    await expect(
      discord.exchange({
        callbackParams: new URLSearchParams(params as Record<string, string>),
        codeVerifier: 'v',
        state: 's',
        nonce: 'n',
      }),
    ).rejects.toThrow();
  });

  it('is configured only with both DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET', () => {
    expect(defaultOAuthProviders(base.env).discord).toBeUndefined();
    expect(defaultOAuthProviders({ ...base.env, DISCORD_CLIENT_ID: 'x' }).discord).toBeUndefined();
    expect(
      defaultOAuthProviders({ ...base.env, DISCORD_CLIENT_ID: 'x', DISCORD_CLIENT_SECRET: 'y' })
        .discord?.id,
    ).toBe('discord');
  });
});

describe('discord oauth routes', () => {
  it('without env vars the endpoints are not found (redirect NOT_FOUND)', async () => {
    const app = createApp(base);
    const r1 = await request(app).get('/api/auth/discord/start');
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe('/login?error=NOT_FOUND');
    const r2 = await request(app).get('/api/auth/discord/callback?code=c&state=s');
    expect(r2.headers.location).toBe('/login?error=NOT_FOUND');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('with env vars start redirects to Discord', async () => {
    const d2 = await testDeps({ DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: 'x' });
    try {
      const res = await request(createApp(d2)).get('/api/auth/discord/start');
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    } finally {
      await closeDeps(d2);
    }
  });

  it('new user: login creates a pending user with the discord identity', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent, '?returnTo=/games');
    const stored = JSON.parse((await redis.get(`oauth:${state}`))!);
    const res = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/complete-profile');
    expect(cookies(res)).toMatch(/nri_sid=/);
    expect(tokenRequests[0]!.body.get('code_verifier')).toBe(stored.codeVerifier);
    const ids = await db.select().from(authIdentities);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({
      provider: 'discord',
      subject: '80351110224678912',
      displayName: 'Nelly',
    });
    // Повторний вхід — той самий користувач.
    await db.update(users).set({ status: 'active' });
    const a2 = request.agent(createApp(deps));
    const s2 = await startFlow(a2, '?returnTo=/games');
    const r2 = await a2.get(`/api/auth/discord/callback?code=c&state=${s2.state}`);
    expect(r2.headers.location).toBe('/games');
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('invalid state: unknown, without cookie, reused → OAUTH_STATE_INVALID, no exchange', async () => {
    const app = createApp(deps);
    const agent = request.agent(app);
    const r1 = await agent.get('/api/auth/discord/callback?code=c&state=nope');
    expect(r1.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    const { state } = await startFlow(agent);
    const r2 = await request(app).get(`/api/auth/discord/callback?code=c&state=${state}`);
    expect(r2.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(fakeFetch).not.toHaveBeenCalled();
    await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
    const r3 = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
    expect(r3.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(tokenRequests).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it('failed token exchange → OAUTH_STATE_INVALID without session', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      tokenStatus = 400;
      const agent = request.agent(createApp(deps));
      const { state } = await startFlow(agent);
      const res = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
      expect(await db.select().from(sessions)).toHaveLength(0);
      expect(JSON.stringify(log.mock.calls)).not.toContain(CLIENT_SECRET);
    } finally {
      log.mockRestore();
    }
  });

  it('access_denied → OAUTH_CANCELLED', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent);
    const res = await agent.get(`/api/auth/discord/callback?error=access_denied&state=${state}`);
    expect(res.headers.location).toBe('/login?error=OAUTH_CANCELLED');
  });

  it('banned tombstone → IDENTITY_BANNED on login, no user created', async () => {
    await db.insert(identityTombstones).values({
      provider: 'discord',
      subjectHash: subjectHash('discord', '80351110224678912', TEST_PEPPER),
      userId: null,
      isBanned: true,
    });
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent);
    const res = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
    expect(res.headers.location).toBe('/login?error=IDENTITY_BANNED');
    expect(await db.select().from(users)).toHaveLength(0);
  });

  describe('link mode', () => {
    it('links discord to the existing account', async () => {
      const app = createApp(deps);
      const { agent, userId } = await loggedInTelegram(app, '2001');
      const { state } = await startFlow(agent, '?mode=link&returnTo=/account');
      const res = await agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/account');
      const rows = await db.select().from(authIdentities).where(eq(authIdentities.userId, userId));
      expect(rows.map((r) => r.provider).sort()).toEqual(['discord', 'telegram']);
      expect(await db.select().from(users)).toHaveLength(1);
    });

    it('discord identity owned by someone else → /account?error=IDENTITY_TAKEN', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '2002');
      const s1 = await startFlow(a.agent, '?mode=link');
      await a.agent.get(`/api/auth/discord/callback?code=c&state=${s1.state}`);
      const b = await loggedInTelegram(app, '2003');
      const s2 = await startFlow(b.agent, '?mode=link');
      const res = await b.agent.get(`/api/auth/discord/callback?code=c&state=${s2.state}`);
      expect(res.headers.location).toBe('/account?error=IDENTITY_TAKEN');
      const d = await db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.provider, 'discord'));
      expect(d).toHaveLength(1);
      expect(d[0]!.userId).toBe(a.userId);
    });

    it('banned tombstone → /account?error=IDENTITY_BANNED', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '2004');
      await db.insert(identityTombstones).values({
        provider: 'discord',
        subjectHash: subjectHash('discord', '80351110224678912', TEST_PEPPER),
        userId: null,
        isBanned: true,
      });
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await a.agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/account?error=IDENTITY_BANNED');
      const d = await db
        .select()
        .from(authIdentities)
        .where(eq(authIdentities.provider, 'discord'));
      expect(d).toHaveLength(0);
    });

    it('callback from another session → OAUTH_STATE_INVALID', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '2005');
      const b = await loggedInTelegram(app, '2006');
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await b.agent.get(`/api/auth/discord/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/account?error=OAUTH_STATE_INVALID');
      expect(fakeFetch).not.toHaveBeenCalled();
    });
  });
});
