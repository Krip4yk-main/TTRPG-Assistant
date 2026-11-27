import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TESTER_REPORTS_PER_HOUR } from '@nri/shared';
import { createApp } from '../../src/app.js';
import { enqueueTelegram } from '../../src/notifications/telegram-outbox.js';
import {
  authIdentities,
  notifications,
  telegramOutbox,
  testerReports,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const devApp = createApp({ ...deps, env: { ...deps.env, DEPLOY_ENV: 'dev' } });
const { login, call } = harness(deps, devApp);

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

type Role = 'user' | 'moderator' | 'admin' | 'owner';
async function user(nickname: string, role: Role = 'user') {
  const u = await createUser(db, { nickname, role });
  return { ...u, cookie: await login(u.id) };
}

const context = {
  url: 'https://dev.nri.example/games/5?tab=info&token=secret#frag',
  theme: 'quest-board',
  viewportWidth: 1280,
  viewportHeight: 720,
  userAgent: 'Mozilla/5.0 Test',
};
const cleanUrl = 'https://dev.nri.example/games/5?tab=info';
const body = (patch: Record<string, unknown> = {}) => ({
  kind: 'bug',
  text: 'Кнопка не тисне',
  context,
  ...patch,
});
const submit = (cookie: string | undefined, b: object = body()) =>
  call('post', '/api/tester-reports', cookie, b);
const ids = (res: { body: { items: { id: number }[] } }) => res.body.items.map((r) => r.id);

describe('tester reports: only on DEPLOY_ENV=dev', () => {
  it.each(['local', 'prod'] as const)('%s: submit and admin endpoints → 404', async (env) => {
    const app = createApp({ ...deps, env: { ...deps.env, DEPLOY_ENV: env } });
    const h = harness(deps, app);
    const owner = await user('Власник', 'owner');
    expect((await h.call('post', '/api/tester-reports', undefined, body())).status).toBe(404);
    expect((await h.call('get', '/api/admin/tester-reports', owner.cookie)).status).toBe(404);
    const mark = await h.call('post', '/api/admin/tester-reports/1/processed', owner.cookie);
    expect(mark.status).toBe(404);
    expect(await db.select().from(testerReports)).toHaveLength(0);
  });
});

describe('POST /api/tester-reports', () => {
  it('guest → 201; context stored, url without secrets, no reporter', async () => {
    const res = await submit(undefined);
    expect(res.status).toBe(201);
    const [r] = await db.select().from(testerReports);
    expect(res.body).toEqual({ id: r!.id });
    expect(r).toMatchObject({
      reporterId: null,
      kind: 'bug',
      text: 'Кнопка не тисне',
      pageUrl: cleanUrl,
      theme: 'quest-board',
      viewportWidth: 1280,
      viewportHeight: 720,
      userAgent: 'Mozilla/5.0 Test',
      status: 'new',
    });
  });

  it('logged in → reporter from the session (client cannot pass one)', async () => {
    const u = await user('Тестер');
    expect((await submit(u.cookie, { ...body(), reporterId: 99 })).status).toBe(400);
    expect((await submit(u.cookie)).status).toBe(201);
    const [r] = await db.select().from(testerReports);
    expect(r!.reporterId).toBe(u.id);
  });

  it('validation: kind, empty/too long text, malformed context → 400; nothing stored', async () => {
    const bad = [
      body({ kind: 'praise' }),
      body({ text: '   ' }),
      body({ text: 'x'.repeat(4001) }),
      body({ context: { ...context, viewportWidth: -1 } }),
      body({ context: { ...context, userAgent: 'x'.repeat(513) } }),
      { kind: 'bug', text: 'x' },
    ];
    for (const b of bad) expect((await submit(undefined, b)).status, JSON.stringify(b)).toBe(400);
    expect(await db.select().from(testerReports)).toHaveLength(0);
  });

  it(`rate limit: ${TESTER_REPORTS_PER_HOUR} per hour per IP, then 429 RATE_LIMITED`, async () => {
    for (let i = 0; i < TESTER_REPORTS_PER_HOUR; i++) {
      expect((await submit(undefined)).status).toBe(201);
    }
    const res = await submit(undefined);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(await db.select().from(testerReports)).toHaveLength(TESTER_REPORTS_PER_HOUR);
  });

  it('notifies each active owner on the site only (no Telegram); not admins', async () => {
    const owner = await user('Власник', 'owner');
    const admin = await user('Адмін', 'admin');
    await db
      .insert(authIdentities)
      .values({ userId: owner.id, provider: 'telegram', subject: '555' });
    expect((await submit(undefined, body({ kind: 'idea' }))).status).toBe(201);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: owner.id,
      type: 'tester.report',
      category: 'moderation',
      payload: {},
    });
    expect(rows.some((n) => n.userId === admin.id)).toBe(false);
    expect(await db.select().from(telegramOutbox)).toHaveLength(0);
    // Пряма постановка в чергу теж пропускає тип лише для сайту.
    expect(await enqueueTelegram(db, rows)).toBe(0);
  });
});

describe('admin: /api/admin/tester-reports', () => {
  async function seed(n: number) {
    for (let i = 0; i < n; i++) expect((await submit(undefined)).status).toBe(201);
    await redis.flushdb();
  }

  it('only admin and owner: guest 401, user/moderator 403', async () => {
    await seed(1);
    expect((await call('get', '/api/admin/tester-reports')).status).toBe(401);
    for (const role of ['user', 'moderator'] as const) {
      const u = await user(`R-${role}`, role);
      expect((await call('get', '/api/admin/tester-reports', u.cookie)).status).toBe(403);
      const mark = await call('post', '/api/admin/tester-reports/1/processed', u.cookie);
      expect(mark.status).toBe(403);
    }
    for (const role of ['admin', 'owner'] as const) {
      const u = await user(`R-${role}`, role);
      expect((await call('get', '/api/admin/tester-reports', u.cookie)).status).toBe(200);
    }
    const [r] = await db.select().from(testerReports);
    expect(r!.status).toBe('new');
  });

  it('list: newest first, status filter, cursor paging, reporter ref', async () => {
    const admin = await user('Адмін', 'admin');
    const tester = await user('Тестер');
    await seed(2);
    const third = await submit(tester.cookie, body({ kind: 'other', text: 'Третій' }));
    expect(third.status).toBe(201);
    const all = await call('get', '/api/admin/tester-reports', admin.cookie);
    expect(ids(all)).toEqual([3, 2, 1]);
    expect(all.body.items[0]).toMatchObject({
      kind: 'other',
      text: 'Третій',
      status: 'new',
      reporter: { publicId: tester.publicId, nickname: 'Тестер', role: 'user' },
      processedBy: null,
      processedAt: null,
      context: { ...context, url: cleanUrl },
    });
    expect(all.body.items[1].reporter).toBeNull();

    const p1 = await call('get', '/api/admin/tester-reports?limit=2', admin.cookie);
    expect(ids(p1)).toEqual([3, 2]);
    expect(p1.body.nextCursor).toBe(2);
    const p2 = await call('get', '/api/admin/tester-reports?limit=2&cursor=2', admin.cookie);
    expect(p2.body).toMatchObject({ items: [{ id: 1 }], nextCursor: null });

    await call('post', '/api/admin/tester-reports/2/processed', admin.cookie);
    expect(ids(await call('get', '/api/admin/tester-reports?status=new', admin.cookie))).toEqual([
      3, 1,
    ]);
    const done = await call('get', '/api/admin/tester-reports?status=processed', admin.cookie);
    expect(ids(done)).toEqual([2]);
    const bad = await call('get', '/api/admin/tester-reports?status=x', admin.cookie);
    expect(bad.status).toBe(400);
  });

  it('mark processed: who and when; repeat keeps the first; unknown id → 404', async () => {
    const admin = await user('Адмін', 'admin');
    const owner = await user('Власник', 'owner');
    await seed(1);
    const res = await call('post', '/api/admin/tester-reports/1/processed', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 1,
      status: 'processed',
      processedBy: { publicId: admin.publicId, nickname: 'Адмін', role: 'admin' },
    });
    expect(typeof res.body.processedAt).toBe('string');
    const again = await call('post', '/api/admin/tester-reports/1/processed', owner.cookie);
    expect(again.status).toBe(200);
    expect(again.body.processedBy.publicId).toBe(admin.publicId);
    expect(again.body.processedAt).toBe(res.body.processedAt);
    for (const id of ['99', 'abc']) {
      const r = await call('post', `/api/admin/tester-reports/${id}/processed`, admin.cookie);
      expect(r.status).toBe(404);
    }
    const [r] = await db.select().from(testerReports).where(eq(testerReports.id, 1));
    expect(r!.processedBy).toBe(admin.id);
  });
});
