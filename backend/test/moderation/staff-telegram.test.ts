import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authIdentities, notifications, telegramOutbox, users } from '../../src/db/schema/index.js';
import { runStaffTelegramReminders } from '../../src/moderation/staff-telegram.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db, redis } = deps;

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const NOW = new Date('2026-11-28T10:00:00.000Z');

describe('runStaffTelegramReminders', () => {
  it('one site notification for each staff member without Telegram — once, never again', async () => {
    const owner = await createUser(db, { role: 'owner', nickname: 'Дошка_Власник' });
    const mod = await createUser(db, { role: 'moderator' });
    const withTg = await createUser(db, { role: 'admin' });
    await db
      .insert(authIdentities)
      .values({ userId: withTg.id, provider: 'telegram', subject: '1' });
    await createUser(db, { role: 'user' });
    await createUser(db, { role: 'admin', isBanned: true });
    await createUser(db, { role: 'moderator', status: 'pending' });

    const sent = await runStaffTelegramReminders(deps, NOW);
    expect(sent.sort()).toEqual([owner.id, mod.id].sort());
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      type: 'staff.telegram_required',
      category: 'moderation',
      payload: {},
      eventId: null,
    });
    // Лише на сайті: Telegram немає, у черзі бота нічого.
    expect(await db.select().from(telegramOutbox)).toEqual([]);
    // Роль не знімається.
    const [o] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(o).toMatchObject({ role: 'owner', staffTelegramRemindedAt: NOW });

    // Повтор (перезапуск) і навіть видалене сповіщення — без нових.
    await db.delete(notifications);
    expect(await runStaffTelegramReminders(deps, NOW)).toEqual([]);
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it('parallel runs (several instances) do not duplicate', async () => {
    await createUser(db, { role: 'admin' });
    await createUser(db, { role: 'moderator' });
    const runs = await Promise.all([
      runStaffTelegramReminders(deps, NOW),
      runStaffTelegramReminders(deps, NOW),
      runStaffTelegramReminders(deps, NOW),
    ]);
    expect(runs.flat()).toHaveLength(2);
    expect(await db.select().from(notifications)).toHaveLength(2);
  });
});
