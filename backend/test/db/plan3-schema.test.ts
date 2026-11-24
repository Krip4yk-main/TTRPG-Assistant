import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  banAppeals,
  gameApplications,
  gameMembers,
  games,
  gameSessions,
  gameSystems,
  genres,
  notes,
  userSettings,
} from '../../src/db/schema/index.js';
import { closeDeps, createUser, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

const DUP = /Duplicate|Failed query/i;

async function insertGame(gmUserId: number): Promise<number> {
  const [sys] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
  const [gen] = await db.select({ id: genres.id }).from(genres).limit(1);
  const [r] = await db
    .insert(games)
    .values({
      gmUserId,
      title: 'Гра',
      description: '',
      systemId: sys!.id,
      genreId: gen!.id,
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
    })
    .$returningId();
  return r!.id;
}

async function setup() {
  const gm = await createUser(db, { nickname: 'Gm' });
  const player = await createUser(db, { nickname: 'Player' });
  const gameId = await insertGame(gm.id);
  return { gm, player, gameId };
}

const application = (gameId: number, userId: number) => ({
  gameId,
  userId,
  answers: [],
  constraints: [],
  warningsAcceptedAt: new Date(),
});

describe('plan 3 schema', () => {
  it('allows only one pending application per player and game', async () => {
    const { player, gameId } = await setup();
    await db.insert(gameApplications).values(application(gameId, player.id));
    await expect(
      db.insert(gameApplications).values(application(gameId, player.id)),
    ).rejects.toThrow(DUP);
  });

  it('allows a new pending application after the previous one was rejected', async () => {
    const { player, gameId } = await setup();
    const [first] = await db
      .insert(gameApplications)
      .values(application(gameId, player.id))
      .$returningId();
    await db
      .update(gameApplications)
      .set({ status: 'rejected', decidedAt: new Date() })
      .where(eq(gameApplications.id, first!.id));
    await db.insert(gameApplications).values(application(gameId, player.id));
    const rows = await db.select().from(gameApplications);
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'rejected']);
    const pending = rows.find((r) => r.status === 'pending')!;
    expect(pending.answers).toEqual([]);
    expect(pending.constraints).toEqual([]);
    expect(pending.cancelReason).toBeNull();
  });

  it('allows only one active membership per user and game', async () => {
    const { player, gameId } = await setup();
    await db.insert(gameMembers).values({ gameId, userId: player.id });
    await expect(db.insert(gameMembers).values({ gameId, userId: player.id })).rejects.toThrow(DUP);
  });

  it('allows a new active membership once the previous one has left_at set', async () => {
    const { player, gameId } = await setup();
    const [m] = await db.insert(gameMembers).values({ gameId, userId: player.id }).$returningId();
    await db
      .update(gameMembers)
      .set({ leftAt: new Date(), leftReason: 'kicked' })
      .where(eq(gameMembers.id, m!.id));
    await db.insert(gameMembers).values({ gameId, userId: player.id });
    const rows = await db.select().from(gameMembers).where(eq(gameMembers.userId, player.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.role === 'player')).toBe(true);
    // Двічі покинути теж можна: неактивних записів може бути скільки завгодно.
    await db.update(gameMembers).set({ leftAt: new Date(), leftReason: 'left' });
    await db.insert(gameMembers).values({ gameId, userId: player.id });
  });

  it('rule-generated sessions are unique per rule slot', async () => {
    const { gameId } = await setup();
    const slot = new Date('2030-01-07T17:00:00Z');
    const s = { gameId, startsAt: slot, durationMinutes: 240, origin: 'rule' as const };
    await db.insert(gameSessions).values({ ...s, ruleStartsAt: slot });
    await expect(db.insert(gameSessions).values({ ...s, ruleStartsAt: slot })).rejects.toThrow(DUP);
    // Ручні сесії (rule_starts_at NULL) не конфліктують.
    await db.insert(gameSessions).values({ ...s, origin: 'manual' });
    await db.insert(gameSessions).values({ ...s, origin: 'manual' });
  });

  it('notes are unique per scope, game, session and user; body holds 200 000 chars', async () => {
    const { player, gameId } = await setup();
    const body = 'ї'.repeat(200_000);
    const n = { scope: 'game_private' as const, gameId, userId: player.id, body, version: 1 };
    await db.insert(notes).values(n);
    await expect(db.insert(notes).values(n)).rejects.toThrow(DUP);
    await db.insert(notes).values({ ...n, scope: 'game_shared' });
    const [row] = await db.select().from(notes).where(eq(notes.scope, 'game_private'));
    expect(row!.body).toHaveLength(200_000);
  });

  it('one appeal per user and ban epoch; ban_epoch defaults to 0', async () => {
    const u = await createUser(db, { isBanned: true });
    expect(u.banEpoch).toBe(0);
    await db.insert(banAppeals).values({ userId: u.id, message: 'a', banEpoch: 0 });
    await expect(
      db.insert(banAppeals).values({ userId: u.id, message: 'b', banEpoch: 0 }),
    ).rejects.toThrow(DUP);
    await db.insert(banAppeals).values({ userId: u.id, message: 'c', banEpoch: 1 });
  });

  it('user settings default to automatic calendar busy time', async () => {
    const u = await createUser(db);
    await db.insert(userSettings).values({ userId: u.id });
    const [s] = await db.select().from(userSettings).where(eq(userSettings.userId, u.id));
    expect(s!.calendarAutoBusy).toBe(true);
  });

  it('creates every plan 3 table', async () => {
    const [rows] = await db.execute(
      sql`SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const names = (rows as unknown as { t: string }[]).map((r) => r.t);
    for (const t of [
      'game_applications',
      'application_constraint_responses',
      'game_bans',
      'gm_blacklist',
      'game_sessions',
      'session_attendance',
      'notes',
      'user_settings',
      'calendar_pinned_games',
      'ban_appeals',
    ])
      expect(names).toContain(t);
  });
});
