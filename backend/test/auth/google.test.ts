import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import type { OAuthProvider } from '../../src/auth/providers/oauth.js';
import { authIdentities, sessions, users } from '../../src/db/schema/index.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { sign, TEST_BOT_TOKEN } from './telegram-sign.js';

const base = await testDeps({ TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN });
let subject = 'g-1';
const fake: OAuthProvider = {
  id: 'google',
  createAuthorizationUrl: (state, verifier) =>
    new URL(`https://accounts.example/auth?state=${state}&cv=${verifier}`),
  exchange: async (code) => {
    if (code === 'bad') throw new Error('exchange failed');
    return { provider: 'google', subject, displayName: 'Gina', avatarUrl: 'https://img/g.png' };
  },
};
const deps = { ...base, oauthProviders: { google: fake } };
const { db, redis } = deps;

beforeEach(async () => {
  subject = 'g-1';
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
  const res = await agent.get(`/api/auth/google/start${qs}`);
  const loc = res.headers.location as string | undefined;
  const state = loc ? new URL(loc).searchParams.get('state') : null;
  return { res, state };
}

describe('google oauth', () => {
  it('start redirects to provider and stores oauth:<state>', async () => {
    const agent = request.agent(createApp(deps));
    const { res, state } = await startFlow(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.example\/auth/);
    const stored = JSON.parse((await redis.get(`oauth:${state}`))!);
    expect(stored).toMatchObject({ mode: 'login', returnTo: '/' });
    expect(stored.codeVerifier).toBeTruthy();
    expect(await redis.ttl(`oauth:${state}`)).toBeGreaterThan(500);
  });

  it('rejects open-redirect returnTo', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent, '?returnTo=//evil.com');
    expect(JSON.parse((await redis.get(`oauth:${state}`))!).returnTo).toBe('/');
    const s2 = await startFlow(agent, '?returnTo=/games');
    expect(JSON.parse((await redis.get(`oauth:${s2.state}`))!).returnTo).toBe('/games');
  });

  it.each(['/\\evil.com', '/%5Cevil.com', 'https://evil.com', 'javascript:alert(1)'])(
    'rejects returnTo %s',
    async (rt) => {
      const agent = request.agent(createApp(deps));
      const { state } = await startFlow(agent, `?returnTo=${encodeURIComponent(rt)}`);
      expect(JSON.parse((await redis.get(`oauth:${state}`))!).returnTo).toBe('/');
    },
  );

  it('array returnTo falls back to /', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent, '?returnTo=/a&returnTo=/b');
    expect(JSON.parse((await redis.get(`oauth:${state}`))!).returnTo).toBe('/');
  });

  it('start sets httpOnly nri_oauth cookie bound to state', async () => {
    const agent = request.agent(createApp(deps));
    const { res, state } = await startFlow(agent);
    const c = cookies(res);
    expect(c).toContain(`nri_oauth=${state}`);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Path=\/api\/auth/);
    expect(c).toMatch(/SameSite=Lax/i);
  });

  it('callback without or with a different nri_oauth cookie is rejected (login CSRF)', async () => {
    const app = createApp(deps);
    const victimStart = await startFlow(request.agent(app));
    // «Жертва» без куки
    const victim = request.agent(app);
    const r1 = await victim.get(`/api/auth/google/callback?code=c&state=${victimStart.state}`);
    expect(r1.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(cookies(r1)).not.toMatch(/nri_sid/);
    // З чужою кукою
    const other = request.agent(app);
    await startFlow(other);
    const r2 = await other.get(`/api/auth/google/callback?code=c&state=${victimStart.state}`);
    expect(r2.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(cookies(r2)).not.toMatch(/nri_sid/);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('successful callback clears the nri_oauth cookie', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent);
    const res = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
    expect(cookies(res)).toMatch(/nri_oauth=;/);
  });

  it('deleted user is redirected with UNAUTHENTICATED', async () => {
    const agent = request.agent(createApp(deps));
    const s1 = await startFlow(agent);
    await agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
    await db.update(users).set({ status: 'deleted' });
    await db.delete(sessions);
    const a2 = request.agent(createApp(deps));
    const s2 = await startFlow(a2);
    const res = await a2.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
    expect(res.headers.location).toBe('/login?error=UNAUTHENTICATED');
  });

  it('unknown/unconfigured provider redirects with NOT_FOUND (top-level navigation)', async () => {
    const agent = request.agent(createApp(deps));
    const r1 = await agent.get('/api/auth/discord/start');
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe('/login?error=NOT_FOUND');
    const r2 = await agent.get('/api/auth/discord/callback?code=x&state=y');
    expect(r2.headers.location).toBe('/login?error=NOT_FOUND');
    expect((await agent.get('/api/auth/discord/start?mode=link')).headers.location).toBe(
      '/account?error=NOT_FOUND',
    );
    const d2 = await testDeps();
    try {
      const r3 = await request(createApp(d2)).get('/api/auth/google/start');
      expect(r3.status).toBe(302);
      expect(r3.headers.location).toBe('/login?error=NOT_FOUND');
    } finally {
      await closeDeps(d2);
    }
  });

  it('invalid mode on start redirects with VALIDATION', async () => {
    const res = await request(createApp(deps)).get('/api/auth/google/start?mode=bogus');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=VALIDATION');
  });

  it('provider ?error=access_denied -> /login?error=OAUTH_CANCELLED, state burned', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent);
    const res = await agent.get(`/api/auth/google/callback?error=access_denied&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=OAUTH_CANCELLED');
    expect(await redis.get(`oauth:${state}`)).toBeNull();
    const other = await agent.get('/api/auth/google/callback?error=server_error');
    expect(other.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
  });

  it('rate-limited start/callback redirect instead of JSON 429', async () => {
    const d2 = await testDeps({ RATE_LIMIT_AUTH_MAX: '1' });
    try {
      const app = createApp({ ...d2, oauthProviders: { google: fake } });
      const agent = request.agent(app);
      expect((await agent.get('/api/auth/google/start')).status).toBe(302);
      const s = await agent.get('/api/auth/google/start?mode=link');
      expect(s.status).toBe(302);
      expect(s.headers.location).toBe('/account?error=RATE_LIMITED');
      const c = await agent.get('/api/auth/google/callback?code=c&state=x');
      expect(c.headers.location).toBe('/login?error=RATE_LIMITED');
      // Звичайні (не навігаційні) маршрути й далі отримують JSON 429.
      const ping = await agent.get('/api/auth/ping');
      expect(ping.status).toBe(429);
      expect(ping.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await closeDeps(d2);
    }
  });

  it('callback with unknown state redirects to OAUTH_STATE_INVALID', async () => {
    const agent = request.agent(createApp(deps));
    const res = await agent.get('/api/auth/google/callback?code=c&state=nope');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    const res2 = await agent.get('/api/auth/google/callback');
    expect(res2.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
  });

  it('callback with valid state logs in, sets cookie, state is one-time', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent, '?returnTo=/games');
    const res = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/complete-profile');
    expect(cookies(res)).toMatch(/nri_sid=/);
    expect(await redis.get(`oauth:${state}`)).toBeNull();
    const again = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
    expect(again.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(await db.select().from(authIdentities)).toHaveLength(1);
  });

  it('active user is redirected to returnTo', async () => {
    const agent = request.agent(createApp(deps));
    const s1 = await startFlow(agent);
    await agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
    await db.update(users).set({ status: 'active' });
    const agent2 = request.agent(createApp(deps));
    const s2 = await startFlow(agent2, '?returnTo=/games');
    const res = await agent2.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
    expect(res.headers.location).toBe('/games');
  });

  it('failed exchange redirects to OAUTH_STATE_INVALID, no session', async () => {
    const agent = request.agent(createApp(deps));
    const { state } = await startFlow(agent);
    const res = await agent.get(`/api/auth/google/callback?code=bad&state=${state}`);
    expect(res.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('banned user is redirected with ACCOUNT_BANNED', async () => {
    const agent = request.agent(createApp(deps));
    const s1 = await startFlow(agent);
    await agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
    await db.update(users).set({ isBanned: true });
    await db.delete(sessions);
    const a2 = request.agent(createApp(deps));
    const s2 = await startFlow(a2);
    const res = await a2.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
    expect(res.headers.location).toBe('/login?error=ACCOUNT_BANNED');
    expect(cookies(res)).not.toMatch(/nri_sid/);
  });

  it('login via oauth revokes an existing session', async () => {
    const app = createApp(deps);
    const agent = request.agent(app);
    const s1 = await startFlow(agent);
    const r1 = await agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
    const old = /nri_sid=([^;]+)/.exec(cookies(r1))![1]!;
    subject = 'g-2';
    const s2 = await startFlow(agent);
    await agent.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
    const stale = await request(app).get('/api/test/protected').set('Cookie', `nri_sid=${old}`);
    expect(stale.status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  describe('link mode', () => {
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

    it('links to the current user instead of creating a new one', async () => {
      const app = createApp(deps);
      const { agent, userId } = await loggedInTelegram(app, '1001');
      const { state } = await startFlow(agent, '?mode=link&returnTo=/account');
      const res = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/account');
      const rows = await db.select().from(authIdentities).where(eq(authIdentities.userId, userId));
      expect(rows.map((r) => r.provider).sort()).toEqual(['google', 'telegram']);
      expect(await db.select().from(users)).toHaveLength(1);
    });

    it('link start rejects banned users', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1010');
      await db.update(users).set({ isBanned: true });
      await redis.flushdb();
      const res = await a.agent.get('/api/auth/google/start?mode=link');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/account?error=ACCOUNT_BANNED');
    });

    it('link start requires a session', async () => {
      const res = await request(createApp(deps)).get('/api/auth/google/start?mode=link');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/account?error=UNAUTHENTICATED');
    });

    it('callback session must match initiating user', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1002');
      const b = await loggedInTelegram(app, '1003');
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await b.agent.get(`/api/auth/google/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/account?error=OAUTH_STATE_INVALID');
      const g = await db.select().from(authIdentities).where(eq(authIdentities.provider, 'google'));
      expect(g).toHaveLength(0);
    });

    it('failed exchange in link mode -> /account?error=OAUTH_STATE_INVALID', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1020');
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await a.agent.get(`/api/auth/google/callback?code=bad&state=${state}`);
      expect(res.headers.location).toBe('/account?error=OAUTH_STATE_INVALID');
    });

    it('cookie mismatch in link mode -> /account (mode read from the state record)', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1021');
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await request(app).get(`/api/auth/google/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/account?error=OAUTH_STATE_INVALID');
      // Чужий callback не спалює state.
      expect(await redis.get(`oauth:${state}`)).not.toBeNull();
    });

    it('missing/expired state falls back to /login', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1022');
      const { state } = await startFlow(a.agent, '?mode=link');
      await redis.del(`oauth:${state}`);
      const res = await a.agent.get(`/api/auth/google/callback?code=c&state=${state}`);
      expect(res.headers.location).toBe('/login?error=OAUTH_STATE_INVALID');
    });

    it('provider ?error=access_denied in link mode -> /account?error=OAUTH_CANCELLED', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1023');
      const { state } = await startFlow(a.agent, '?mode=link');
      const res = await a.agent.get(`/api/auth/google/callback?error=access_denied&state=${state}`);
      expect(res.headers.location).toBe('/account?error=OAUTH_CANCELLED');
      expect(await redis.get(`oauth:${state}`)).toBeNull();
    });

    it('identity owned by someone else -> /account?error=IDENTITY_TAKEN', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1004');
      const s1 = await startFlow(a.agent, '?mode=link');
      await a.agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
      const b = await loggedInTelegram(app, '1005');
      const s2 = await startFlow(b.agent, '?mode=link');
      const res = await b.agent.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
      expect(res.headers.location).toBe('/account?error=IDENTITY_TAKEN');
    });

    it('second google identity -> /account?error=PROVIDER_ALREADY_LINKED', async () => {
      const app = createApp(deps);
      const a = await loggedInTelegram(app, '1006');
      const s1 = await startFlow(a.agent, '?mode=link');
      await a.agent.get(`/api/auth/google/callback?code=c&state=${s1.state}`);
      subject = 'g-other';
      const s2 = await startFlow(a.agent, '?mode=link');
      const res = await a.agent.get(`/api/auth/google/callback?code=c&state=${s2.state}`);
      expect(res.headers.location).toBe('/account?error=PROVIDER_ALREADY_LINKED');
    });
  });
});
