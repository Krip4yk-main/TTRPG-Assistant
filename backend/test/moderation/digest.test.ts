import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  authIdentities,
  complaints,
  jobs,
  moderationDigestLog,
  notificationPrefs,
  notifications,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { registerJobs } from '../../src/jobs/index.js';
import { getHandler, getRecurring, resetRegistry } from '../../src/jobs/registry.js';
import {
  DIGEST_EVERY_MS,
  DIGEST_JOB,
  isDigestSlot,
  kyivLocal,
  sendModerationDigest,
} from '../../src/moderation/digest.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';
import { ratingFixtures } from '../ratings/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  resetRegistry();
  await redis.flushdb();
  await closeDeps(deps);
});

// 09:00 за Києвом: узимку (UTC+2) — 07:00Z, улітку (UTC+3) — 06:00Z.
const WINTER_9 = new Date('2026-12-01T07:00:00.000Z');
const SUMMER_9 = new Date('2026-07-01T06:00:00.000Z');

describe('digest schedule (Europe/Kyiv, DST)', () => {
  it('kyivLocal: date and hour in Kyiv for both offsets', () => {
    expect(kyivLocal(WINTER_9)).toEqual({ date: '2026-12-01', hour: 9 });
    expect(kyivLocal(SUMMER_9)).toEqual({ date: '2026-07-01', hour: 9 });
    expect(kyivLocal(new Date('2026-12-01T06:00:00.000Z')).hour).toBe(8);
    expect(kyivLocal(new Date('2026-07-01T07:00:00.000Z')).hour).toBe(10);
    // Після півночі за Києвом — уже наступна дата.
    expect(kyivLocal(new Date('2026-12-01T22:30:00.000Z')).date).toBe('2026-12-02');
  });

  it('exactly one hourly slot per day is the digest slot, incl. DST switch days', () => {
    for (const day of ['2026-03-29', '2026-03-30', '2026-10-25', '2026-10-26', '2026-12-01']) {
      const start = new Date(`${day}T00:00:00.000Z`).getTime() - 3 * 3_600_000;
      const slots: string[] = [];
      for (let h = 0; h < 24; h++) {
        const t = new Date(start + h * 3_600_000);
        if (isDigestSlot(t)) slots.push(t.toISOString());
      }
      expect(slots, day).toHaveLength(1);
      expect(kyivLocal(new Date(slots[0]!)), day).toEqual({ date: day, hour: 9 });
    }
    // Повтор після збою (не рівно на годину) належить своєму слоту.
    expect(isDigestSlot(new Date('2026-12-01T07:30:00.000Z'))).toBe(true);
    expect(isDigestSlot(new Date('2026-12-01T08:00:00.000Z'))).toBe(false);
    expect(isDigestSlot(new Date('2026-12-01T06:59:59.999Z'))).toBe(false);
  });

  it('registered as an hourly recurring job whose handler uses job.runAt', async () => {
    resetRegistry();
    registerJobs();
    expect(getRecurring(DIGEST_JOB)).toEqual({ everyMs: DIGEST_EVERY_MS });
    expect(DIGEST_EVERY_MS).toBe(3_600_000);
    const mod = await createUser(db, { role: 'moderator' });
    const rep = await createUser(db);
    await db
      .insert(complaints)
      .values({ reporterId: rep.id, targetGameId: null, targetUserId: rep.id, reason: 'other' });
    const handler = getHandler(DIGEST_JOB)!;
    const job = { runAt: WINTER_9 } as typeof jobs.$inferSelect;
    await handler(deps, null, job);
    await handler(deps, null, { ...job, runAt: new Date('2026-12-01T08:00:00.000Z') });
    const rows = await db.select().from(notifications);
    expect(rows).toEqual([expect.objectContaining({ userId: mod.id, type: 'moderation.digest' })]);
  });

  it('a retry of the 09:00 slot (runAt = failure + backoff) still sends', async () => {
    resetRegistry();
    registerJobs();
    const mod = await createUser(db, { role: 'moderator' });
    const rep = await createUser(db);
    await db
      .insert(complaints)
      .values({ reporterId: rep.id, targetUserId: rep.id, reason: 'other' });
    const handler = getHandler(DIGEST_JOB)!;
    const retry = { runAt: new Date('2026-12-01T07:00:37.000Z') } as typeof jobs.$inferSelect;
    await handler(deps, null, retry);
    const rows = await db.select().from(notifications);
    expect(rows).toEqual([expect.objectContaining({ userId: mod.id, type: 'moderation.digest' })]);
    const [log] = await db.select().from(moderationDigestLog);
    expect(log!.digestDate).toBe('2026-12-01');
  });
});

describe('sendModerationDigest', () => {
  async function staff() {
    const owner = await createUser(db, { role: 'owner', nickname: 'Owner' });
    const admin = await createUser(db, { role: 'admin', nickname: 'Admin' });
    const mod = await createUser(db, { role: 'moderator', nickname: 'Mod' });
    const plain = await createUser(db, { nickname: 'Plain' });
    return { owner, admin, mod, plain };
  }
  const seed = (reporterId: number, targetUserId: number, status: 'new' | 'dismissed' = 'new') =>
    db.insert(complaints).values({ reporterId, targetUserId, reason: 'other', status });

  const counts = async () =>
    Object.fromEntries(
      (await db.select().from(notifications)).map((n) => [n.userId, n.payload.count]),
    );

  it('no new complaints → nothing (also nothing in the log)', async () => {
    const s = await staff();
    await seed(s.plain.id, s.plain.id, 'dismissed');
    expect(await sendModerationDigest(deps, WINTER_9)).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
    expect(await db.select().from(moderationDigestLog)).toEqual([]);
  });

  it('each active staff member gets one digest with the count of new complaints visible to them', async () => {
    const s = await staff();
    const rep = await createUser(db);
    await seed(rep.id, s.plain.id);
    await seed(rep.id, s.plain.id);
    await seed(rep.id, s.plain.id, 'dismissed');
    await seed(rep.id, s.mod.id); // видно адміну й власнику
    await seed(rep.id, s.admin.id); // видно лише власнику
    // Неактивний і забанений персонал — без зведення.
    await createUser(db, { role: 'moderator', status: 'deleted' });
    await createUser(db, { role: 'moderator', isBanned: true });
    const created = await sendModerationDigest(deps, WINTER_9);
    expect(created).toHaveLength(3);
    expect(await counts()).toEqual({ [s.mod.id]: 2, [s.admin.id]: 3, [s.owner.id]: 4 });
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, s.mod.id));
    expect(n).toMatchObject({
      type: 'moderation.digest',
      category: 'moderation',
      payload: { count: 2 },
    });
  });

  it('game complaints are counted by the GM role', async () => {
    const s = await staff();
    const rep = await createUser(db);
    const gameOf = (gm: number) => ratingFixtures(db).game(gm);
    await db.insert(complaints).values([
      { reporterId: rep.id, targetGameId: await gameOf(s.plain.id), reason: 'other' },
      { reporterId: rep.id, targetGameId: await gameOf(s.mod.id), reason: 'other' },
      { reporterId: rep.id, targetGameId: await gameOf(s.admin.id), reason: 'other' },
    ]);
    await sendModerationDigest(deps, WINTER_9);
    expect(await counts()).toEqual({ [s.mod.id]: 1, [s.admin.id]: 2, [s.owner.id]: 3 });
  });

  it('only staff with something visible: moderator with 0 visible gets nothing', async () => {
    const s = await staff();
    const rep = await createUser(db);
    await seed(rep.id, s.mod.id);
    await sendModerationDigest(deps, SUMMER_9);
    expect(await counts()).toEqual({ [s.admin.id]: 1, [s.owner.id]: 1 });
  });

  it('rerun of the same slot (and any other slot of the same Kyiv day) → no duplicates', async () => {
    const s = await staff();
    await seed(s.plain.id, s.plain.id);
    expect(await sendModerationDigest(deps, WINTER_9)).toHaveLength(3);
    expect(await sendModerationDigest(deps, WINTER_9)).toEqual([]);
    await Promise.all([sendModerationDigest(deps, WINTER_9), sendModerationDigest(deps, WINTER_9)]);
    expect(await db.select().from(notifications)).toHaveLength(3);
    expect(await db.select().from(moderationDigestLog)).toHaveLength(3);
    // Наступного дня — знову.
    const next = new Date(WINTER_9.getTime() + 86_400_000);
    expect(await sendModerationDigest(deps, next)).toHaveLength(3);
  });

  it('outside the 09:00 Kyiv slot → nothing', async () => {
    const s = await staff();
    await seed(s.plain.id, s.plain.id);
    expect(await sendModerationDigest(deps, new Date('2026-12-01T06:00:00.000Z'))).toEqual([]);
    expect(await sendModerationDigest(deps, new Date('2026-07-01T07:00:00.000Z'))).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('Telegram: on by default for moderation; off in prefs → no outbox row', async () => {
    const s = await staff();
    await seed(s.plain.id, s.plain.id);
    await db.insert(authIdentities).values([
      { userId: s.mod.id, provider: 'telegram', subject: '8001' },
      { userId: s.admin.id, provider: 'telegram', subject: '8002' },
    ]);
    const legacy = {
      applications: true,
      members: true,
      sessions: true,
      reminders: true,
      games: true,
      ratings: true,
    };
    // Рядок до появи категорії — moderation увімкнено за замовчуванням.
    await db.insert(notificationPrefs).values([
      { userId: s.mod.id, telegram: legacy, reminderOffsets: [60] },
      { userId: s.admin.id, telegram: { ...legacy, moderation: false }, reminderOffsets: [60] },
    ]);
    await sendModerationDigest(deps, WINTER_9);
    const outbox = await db.select().from(telegramOutbox);
    expect(outbox.map((o) => o.userId)).toEqual([s.mod.id]);
  });
});
