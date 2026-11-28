import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { publicConfigSchema } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { closeDeps, testDeps } from '../helpers.js';

const base = await testDeps();

async function appWith(extra: Record<string, string>) {
  const d = await testDeps(extra);
  d.redis.disconnect();
  return createApp({ ...d, db: base.db, redis: base.redis });
}

beforeEach(async () => {
  await base.redis.flushdb();
});
afterAll(async () => {
  await base.redis.flushdb();
  await closeDeps(base);
});

describe('GET /api/public-config', () => {
  it('is all off with an empty .env', async () => {
    const res = await request(await appWith({})).get('/api/public-config');
    expect(res.status).toBe(200);
    expect(publicConfigSchema.parse(res.body)).toEqual({
      telegramBotUsername: null,
      providers: { telegram: false, google: false, discord: false },
    });
  });

  it('turns providers on from the backend env', async () => {
    const app = await appWith({
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_BOT_USERNAME: '@nri_test_bot',
      GOOGLE_CLIENT_ID: 'g-id',
      GOOGLE_CLIENT_SECRET: 'g-secret',
      DISCORD_CLIENT_ID: 'd-id',
      DISCORD_CLIENT_SECRET: 'd-secret',
    });
    const res = await request(app).get('/api/public-config');
    expect(res.body).toEqual({
      telegramBotUsername: 'nri_test_bot',
      providers: { telegram: true, google: true, discord: true },
    });
  });

  it('needs both parts of a provider (id+secret, username+token)', async () => {
    const app = await appWith({
      TELEGRAM_BOT_USERNAME: 'nri_test_bot',
      GOOGLE_CLIENT_ID: 'g-id',
      DISCORD_CLIENT_SECRET: 'd-secret',
    });
    const res = await request(app).get('/api/public-config');
    expect(res.body).toEqual({
      telegramBotUsername: null,
      providers: { telegram: false, google: false, discord: false },
    });
  });

  it('is cacheable for a minute, needs no session and sets no cookies', async () => {
    const res = await request(await appWith({})).get('/api/public-config');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('exposes nothing but the two documented keys, even on a beta server with dev login', async () => {
    const app = await appWith({
      DEPLOY_ENV: 'dev',
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://dev.nri.example.com',
      TRUST_PROXY: '1',
      DEV_LOGIN_ENABLED: 'true',
      DEV_LOGIN_CODES: 'alice:beta-test-code-alice-0123456789',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_BOT_USERNAME: 'nri_test_bot',
    });
    const res = await request(app).get('/api/public-config');
    expect(Object.keys(res.body as object).sort()).toEqual(['providers', 'telegramBotUsername']);
    expect(Object.keys((res.body as { providers: object }).providers).sort()).toEqual([
      'discord',
      'google',
      'telegram',
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('123:abc');
  });
});
