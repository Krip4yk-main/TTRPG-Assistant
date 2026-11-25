import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  banAppeals,
  complaints,
  games,
  gameSystems,
  genres,
  identityTombstones,
  moderationLog,
  ratings,
  sanctionAppeals,
  sanctions,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

const mysqlError = (re: RegExp) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringMatching(re) }),
  });

/**
 * Дані-частина міграції 0023 (перенесення `ban_appeals`). Міграції виконуються один раз у
 * global setup на порожній БД, тож тут ті самі SQL-оператори з файлу міграції запускаються
 * на заздалегідь засіяному стані (таблиці санкцій порожні після `resetDb`, як і в момент міграції).
 */
const DATA_STATEMENTS = readFileSync('src/db/migrations/0023_plan6_moderation.sql', 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => /INSERT INTO/.test(s));

async function makeGame(gmUserId: number) {
  const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [g] = await db
    .insert(games)
    .values({
      gmUserId,
      title: 'Гра',
      description: '',
      systemId: sys!.id,
      genreId: gen!.id,
      format: 'online',
      kind: 'oneshot',
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      durationMinutes: 240,
      recurrence: 'none',
      weekdays: [],
      timezone: 'Europe/Kyiv',
      minPlayers: 1,
      maxPlayers: 5,
      status: 'recruiting',
      publishedAt: new Date(),
    })
    .$returningId();
  return g!.id;
}

describe('plan 6 schema', () => {
  it('complaint has exactly one target', async () => {
    const reporter = await createUser(db, { nickname: 'Rep' });
    const target = await createUser(db, { nickname: 'Tgt' });
    const gameId = await makeGame(target.id);
    await db
      .insert(complaints)
      .values({ reporterId: reporter.id, targetUserId: target.id, reason: 'scam' });
    await db
      .insert(complaints)
      .values({ reporterId: reporter.id, targetGameId: gameId, reason: 'other' });
    const CK = mysqlError(/complaints_one_target_ck/);
    await expect(
      db.insert(complaints).values({ reporterId: reporter.id, reason: 'scam' }),
    ).rejects.toThrow(CK);
    await expect(
      db.insert(complaints).values({
        reporterId: reporter.id,
        targetUserId: target.id,
        targetGameId: gameId,
        reason: 'scam',
      }),
    ).rejects.toThrow(CK);
    const [c] = await db.select().from(complaints).limit(1);
    expect(c).toMatchObject({ status: 'new', message: '', resolvedBy: null, sanctionId: null });
  });

  it('one appeal per sanction; log, tombstone user and rating moderation columns exist', async () => {
    const u = await createUser(db, { nickname: 'U' });
    const mod = await createUser(db, { nickname: 'Mod', role: 'moderator' });
    const [s] = await db
      .insert(sanctions)
      .values({
        userId: u.id,
        type: 'warning',
        reason: 'r',
        imposedBy: mod.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .$returningId();
    await db.insert(sanctionAppeals).values({ sanctionId: s!.id, userId: u.id, message: 'm' });
    await expect(
      db.insert(sanctionAppeals).values({ sanctionId: s!.id, userId: u.id, message: 'm2' }),
    ).rejects.toThrow(mysqlError(/Duplicate entry/));

    await db.insert(moderationLog).values({
      actorId: mod.id,
      action: 'sanction.impose',
      targetType: 'user',
      targetId: u.id,
      reason: 'r',
      meta: { type: 'warning' },
    });
    const [log] = await db.select().from(moderationLog);
    expect(log).toMatchObject({ actorId: mod.id, meta: { type: 'warning' } });

    await db
      .insert(identityTombstones)
      .values({ provider: 'telegram', subjectHash: 'a'.repeat(64), userId: u.id });
    const [t] = await db.select().from(identityTombstones);
    expect(t!.userId).toBe(u.id);

    const gameId = await makeGame(mod.id);
    await db.insert(ratings).values({
      raterId: u.id,
      rateeId: mod.id,
      gameId,
      kind: 'final',
      role: 'gm',
      overall: 5,
    });
    const [r] = await db.select().from(ratings);
    expect(r).toMatchObject({ moderated: 'none', moderatedBy: null, moderatedAt: null });
  });
});

describe('migration 0023: ban_appeals → sanctions + sanction_appeals', () => {
  it('has the data statements', () => {
    expect(DATA_STATEMENTS).toHaveLength(4);
  });

  it('moves current bans (with and without appeal) and past appeals', async () => {
    // Забанений з апеляцією на поточний бан.
    const appealed = await createUser(db, { nickname: 'Appealed', isBanned: true, banEpoch: 2 });
    // Забанений без апеляції.
    const silent = await createUser(db, { nickname: 'Silent', isBanned: true, banEpoch: 1 });
    // Розбанений з апеляцією на минулий бан.
    const unbanned = await createUser(db, { nickname: 'Unbanned', isBanned: false, banEpoch: 1 });
    // Не забанений, без апеляцій — нічого.
    await createUser(db, { nickname: 'Clean' });

    const appealAt = new Date('2026-11-20T10:00:00.000Z');
    const pastAt = new Date('2026-11-01T09:00:00.000Z');
    // Апеляція на минулий бан того ж забаненого (epoch 1) і на поточний (epoch 2).
    await db.insert(banAppeals).values([
      { userId: appealed.id, banEpoch: 1, message: 'Старий бан', createdAt: pastAt },
      { userId: appealed.id, banEpoch: 2, message: 'Прошу розбанити', createdAt: appealAt },
      { userId: unbanned.id, banEpoch: 1, message: 'Минуле', createdAt: pastAt },
    ]);

    for (const stmt of DATA_STATEMENTS) await db.execute(sql.raw(stmt));

    const rows = await db.select().from(sanctions).orderBy(asc(sanctions.id));
    expect(rows).toHaveLength(4);
    expect(rows.every((s) => s.type === 'global_ban' && s.imposedBy === null)).toBe(true);
    expect(rows.every((s) => s.endsAt === null && s.complaintId === null)).toBe(true);

    const active = rows.filter((s) => s.liftedAt === null);
    expect(active.map((s) => s.userId).sort()).toEqual([appealed.id, silent.id].sort());
    const past = rows.filter((s) => s.liftedAt !== null);
    expect(past.map((s) => s.userId).sort()).toEqual([appealed.id, unbanned.id].sort());
    expect(past.every((s) => s.liftedBy === null)).toBe(true);

    const appealedBan = active.find((s) => s.userId === appealed.id)!;
    expect(appealedBan.startsAt.toISOString()).toBe(appealAt.toISOString());
    expect(appealedBan.reason).toBe('Бан, накладений до запуску модерації.');

    const appeals = await db.select().from(sanctionAppeals).orderBy(asc(sanctionAppeals.id));
    expect(appeals).toHaveLength(3);
    const current = appeals.find((a) => a.sanctionId === appealedBan.id)!;
    expect(current).toMatchObject({
      userId: appealed.id,
      message: 'Прошу розбанити',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
    });
    expect(current.createdAt.toISOString()).toBe(appealAt.toISOString());

    for (const p of past) {
      const [a] = appeals.filter((x) => x.sanctionId === p.id);
      expect(a).toMatchObject({ userId: p.userId, status: 'accepted', decidedBy: null });
      expect(a!.decidedAt).not.toBeNull();
    }
    const silentAppeals = await db
      .select()
      .from(sanctionAppeals)
      .where(eq(sanctionAppeals.userId, silent.id));
    expect(silentAppeals).toEqual([]);
  });

  it('does nothing on an empty database', async () => {
    for (const stmt of DATA_STATEMENTS) await db.execute(sql.raw(stmt));
    expect(await db.select().from(sanctions)).toEqual([]);
    expect(await db.select().from(sanctionAppeals)).toEqual([]);
  });
});
