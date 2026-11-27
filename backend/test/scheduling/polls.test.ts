import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, asc, eq } from 'drizzle-orm';
import { nextWeeklyStart, toZoned, zonedToUtc, type PollDto, type Weekday } from '@nri/shared';
import { createApp } from '../../src/app.js';
import {
  authIdentities,
  events,
  games,
  gameSessions,
  notifications,
  pollOptions,
  polls,
  pollVotes,
  telegramOutbox,
} from '../../src/db/schema/index.js';
import { dispatchEvents } from '../../src/notifications/dispatcher.js';
import { runPollsClose } from '../../src/scheduling/polls.service.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';
import { harness } from '../games/fixtures.js';

const deps = await testDeps();
const { db, redis } = deps;
const app = createApp(deps);
const { userWithAge, call, createGame } = harness(deps, app);
const KEY = 'test-internal-key-0123456789abcdefghij';

beforeEach(async () => {
  await redis.flushdb();
  await resetDb(db);
});
afterAll(async () => {
  await redis.flushdb();
  await closeDeps(deps);
});

const DAY = 86_400_000;
const KYIV = 'Europe/Kyiv';
const LEAVE = { noteForGm: 'Переїжджаю в інше місто' };

type User = Awaited<ReturnType<typeof userWithAge>>;

/** `hour`:`minute` Kyiv через `daysAhead` діб (ISO) і день тижня. */
function kyivAt(daysAhead: number, hour = 19, minute = 0) {
  const z = toZoned(new Date(Date.now() + daysAhead * DAY), KYIV);
  const at = zonedToUtc({ year: z.year, month: z.month, day: z.day, hour, minute }, KYIV);
  return { iso: at.toISOString(), weekday: z.weekday };
}

async function join(gm: User, gameId: number, p: User): Promise<void> {
  const a = await call('post', `/api/games/${gameId}/applications`, p.cookie, {
    warningsAccepted: true,
    answers: [],
  });
  if (a.status !== 201) throw new Error(`apply ${a.status} ${JSON.stringify(a.body)}`);
  const ok = await call('post', `/api/applications/${a.body.id}/approve`, gm.cookie);
  if (ok.status !== 200) throw new Error(`approve ${ok.status} ${JSON.stringify(ok.body)}`);
}

const first = kyivAt(2);

/** Опублікована щотижнева кампанія з двома учасниками. */
async function group(patch: Record<string, unknown> = {}) {
  const gm = await userWithAge(30, 'gm');
  const a = await userWithAge(25, 'a');
  const b = await userWithAge(25, 'b');
  const stranger = await userWithAge(25, 's');
  const gameId = await createGame(
    gm.cookie,
    { startsAt: first.iso, weekdays: [first.weekday], ...patch },
    true,
  );
  await join(gm, gameId, a);
  await join(gm, gameId, b);
  return { gm, a, b, stranger, gameId };
}

const deadline = (days = 3) => new Date(Date.now() + days * DAY).toISOString();
const oneOffBody = (extra: Record<string, unknown> = {}) => ({
  kind: 'one_off',
  options: [{ startsAt: kyivAt(5).iso }, { startsAt: kyivAt(6, 18, 30).iso }],
  closesAt: deadline(),
  ...extra,
});

async function createPoll(gm: User, gameId: number, body: object = oneOffBody()) {
  const res = await call('post', `/api/games/${gameId}/polls`, gm.cookie, body);
  if (res.status !== 201) throw new Error(`poll ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as PollDto;
}

const votes = (u: User, poll: PollDto, values: ('yes' | 'no' | 'maybe')[]) =>
  call('put', `/api/polls/${poll.id}/votes`, u.cookie, {
    votes: poll.options.map((o, i) => ({ optionId: o.id, value: values[i] ?? 'no' })),
  });

const closedEvents = async (pollId: number) =>
  db
    .select()
    .from(events)
    .where(and(eq(events.type, 'poll.closed'), eq(events.entityId, pollId)));

const pollRow = async (id: number) => (await db.select().from(polls).where(eq(polls.id, id)))[0]!;

describe('polls: permissions (RF 2)', () => {
  it('only the GM creates, closes and applies; members and the GM see; strangers and ex-members do not', async () => {
    const { gm, a, b, stranger, gameId } = await group();
    expect((await call('post', `/api/games/${gameId}/polls`, undefined, oneOffBody())).status).toBe(
      401,
    );
    for (const u of [a, stranger]) {
      const r = await call('post', `/api/games/${gameId}/polls`, u.cookie, oneOffBody());
      expect(r.status).toBe(403);
    }
    const poll = await createPoll(gm, gameId);
    expect(poll).toMatchObject({ kind: 'one_off', status: 'open', isGm: true, canVote: false });
    expect(poll.voters.map((v) => v.nickname)).toEqual(['a', 'b']);
    expect(poll.options.map((o) => o.position)).toEqual([1, 2]);

    expect((await call('get', `/api/games/${gameId}/polls`, a.cookie)).status).toBe(200);
    const mine = await call('get', `/api/polls/${poll.id}`, a.cookie);
    expect(mine.body).toMatchObject({ isGm: false, canVote: true });
    for (const path of [`/api/games/${gameId}/polls`, `/api/polls/${poll.id}`]) {
      const r = await call('get', path, stranger.cookie);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NOT_A_MEMBER');
    }
    expect((await call('get', '/api/polls/999999', gm.cookie)).status).toBe(404);

    // Майстер не голосує; сторонній теж.
    for (const u of [gm, stranger]) {
      const r = await votes(u, poll, ['yes', 'yes']);
      expect(r.status).toBe(403);
    }
    // Колишній учасник: ні перегляду, ні голосу; його старі відповіді не рахуються.
    expect((await votes(b, poll, ['yes', 'yes'])).status).toBe(200);
    expect((await call('post', `/api/games/${gameId}/leave`, b.cookie, LEAVE)).status).toBe(204);
    expect((await votes(b, poll, ['no', 'no'])).status).toBe(403);
    expect((await call('get', `/api/polls/${poll.id}`, b.cookie)).status).toBe(403);
    const after = (await call('get', `/api/polls/${poll.id}`, gm.cookie)).body as PollDto;
    expect(after.voters.map((v) => v.nickname)).toEqual(['a']);
    expect(after.options[0]!.yes).toBe(0);

    for (const action of ['close', 'apply']) {
      expect((await call('post', `/api/polls/${poll.id}/${action}`, a.cookie, {})).status).toBe(
        403,
      );
    }
  });

  it('validates the poll: 2–6 options, deadline ≤ 14 days, future times, regular only for campaigns, own session', async () => {
    const { gm, gameId } = await group();
    const bad = async (body: object, status: number) => {
      const r = await call('post', `/api/games/${gameId}/polls`, gm.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
    };
    await bad(oneOffBody({ options: [{ startsAt: kyivAt(5).iso }] }), 400);
    await bad(
      oneOffBody({
        options: Array.from({ length: 7 }, (_, i) => ({ startsAt: kyivAt(i + 3).iso })),
      }),
      400,
    );
    await bad(
      oneOffBody({ options: [{ startsAt: kyivAt(5).iso }, { startsAt: kyivAt(5).iso }] }),
      400,
    );
    await bad(oneOffBody({ closesAt: deadline(15) }), 400);
    await bad(oneOffBody({ closesAt: deadline(-1) }), 400);
    await bad(
      oneOffBody({ options: [{ startsAt: kyivAt(-2).iso }, { startsAt: kyivAt(5).iso }] }),
      400, // раніше дедлайну (і в минулому)
    );
    await bad(oneOffBody({ sessionId: 999_999 }), 400);
    await bad(
      { kind: 'regular', options: [{ startsAt: kyivAt(5).iso }], closesAt: deadline() },
      400,
    );
    await bad({ ...oneOffBody(), extra: 1 }, 400);

    // Гра без учасників — голосувати нікому.
    const lonely = await createGame(
      gm.cookie,
      { startsAt: first.iso, weekdays: [first.weekday] },
      true,
    );
    const empty = await call('post', `/api/games/${lonely}/polls`, gm.cookie, oneOffBody());
    expect(empty.status).toBe(400);
    // Не більше трьох відкритих голосувань на гру.
    for (let i = 0; i < 3; i++) await createPoll(gm, gameId);
    const limit = await call('post', `/api/games/${gameId}/polls`, gm.cookie, oneOffBody());
    expect(limit.status).toBe(409);
    expect(limit.body.error.code).toBe('POLL_LIMIT');
  });
});

describe('polls: voting and closing (RF 4)', () => {
  it('votes change until closed; unknown option 400; all voted → closes once and notifies the GM', async () => {
    const { gm, a, b, gameId } = await group();
    const poll = await createPoll(gm, gameId);
    expect((await votes(a, poll, ['yes', 'no'])).status).toBe(200);
    const changed = await votes(a, poll, ['maybe', 'yes']);
    expect(
      changed.body.options.map((o: { yes: number; maybe: number }) => [o.yes, o.maybe]),
    ).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(changed.body.voters).toEqual([
      { userId: a.id, nickname: 'a', voted: true },
      { userId: b.id, nickname: 'b', voted: false },
    ]);
    const unknown = await call('put', `/api/polls/${poll.id}/votes`, a.cookie, {
      votes: [{ optionId: 999_999, value: 'yes' }],
    });
    expect(unknown.status).toBe(400);
    // Часткова відповідь b не закриває; повна — закриває.
    await call('put', `/api/polls/${poll.id}/votes`, b.cookie, {
      votes: [{ optionId: poll.options[1]!.id, value: 'yes' }],
    });
    expect((await pollRow(poll.id)).status).toBe('open');
    const done = await votes(b, poll, ['no', 'yes']);
    expect(done.body).toMatchObject({
      status: 'closed',
      closeReason: 'all_voted',
      winnerOptionId: poll.options[1]!.id,
      canVote: false,
    });
    expect(await closedEvents(poll.id)).toHaveLength(1);
    const late = await votes(a, poll, ['no', 'no']);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('POLL_CLOSED');
    // Джоб і повторне закриття майстром нічого не дублюють.
    expect(await runPollsClose(deps)).toBe(0);
    const again = await call('post', `/api/polls/${poll.id}/close`, gm.cookie);
    expect(again.status).toBe(200);
    expect(again.body.closeReason).toBe('all_voted');
    expect(await closedEvents(poll.id)).toHaveLength(1);

    await dispatchEvents(deps);
    const gmNotes = await db.select().from(notifications).where(eq(notifications.userId, gm.id));
    const closed = gmNotes.filter((n) => n.type === 'poll.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ category: 'schedule' });
    expect(closed[0]!.payload).toMatchObject({
      pollId: poll.id,
      closeReason: 'all_voted',
      startsAt: poll.options[1]!.startsAt,
    });
  });

  it('deadline: the job closes exactly once (repeat and parallel runs), votes after it are refused', async () => {
    const { gm, a, gameId } = await group();
    const poll = await createPoll(gm, gameId);
    await votes(a, poll, ['yes', 'no']);
    expect(await runPollsClose(deps)).toBe(0);
    await db
      .update(polls)
      .set({ closesAt: new Date(Date.now() - 1000) })
      .where(eq(polls.id, poll.id));
    // Дедлайн минув, а джоб ще не пройшов: голос уже не приймається.
    expect((await votes(a, poll, ['no', 'no'])).status).toBe(409);
    const runs = await Promise.all([runPollsClose(deps), runPollsClose(deps), runPollsClose(deps)]);
    expect(runs.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await runPollsClose(deps)).toBe(0);
    expect(await pollRow(poll.id)).toMatchObject({ status: 'closed', closeReason: 'deadline' });
    expect(await closedEvents(poll.id)).toHaveLength(1);
  });

  it('the job closes a poll when the last non-voter leaves; GM close does not notify the GM', async () => {
    const { gm, a, b, gameId } = await group();
    const poll = await createPoll(gm, gameId);
    await votes(a, poll, ['yes', 'yes']);
    await call('post', `/api/games/${gameId}/leave`, b.cookie, LEAVE);
    expect(await runPollsClose(deps)).toBe(1);
    expect((await pollRow(poll.id)).closeReason).toBe('all_voted');

    const p2 = await createPoll(gm, gameId);
    const closed = await call('post', `/api/polls/${p2.id}/close`, gm.cookie);
    expect(closed.body).toMatchObject({ status: 'closed', closeReason: 'gm' });
    await dispatchEvents(deps);
    const gmPollNotes = (
      await db.select().from(notifications).where(eq(notifications.userId, gm.id))
    ).filter((n) => n.type === 'poll.closed');
    expect(gmPollNotes.map((n) => n.entityId)).toEqual([poll.id]);
  });
});

describe('polls: regular winner date at close', () => {
  it('the GM notification uses the next occurrence after closing, not the one captured at creation', async () => {
    const { gm, a, gameId } = await group();
    const poll = await createPoll(gm, gameId, {
      kind: 'regular',
      options: [
        { weekday: 1, startMin: 19 * 60 },
        { weekday: 3, startMin: 19 * 60 },
      ],
      closesAt: deadline(),
    });
    await votes(a, poll, ['yes', 'no']);
    // Голосування тривало довго: знята при створенні дата вже минула.
    const stale = new Date(Math.floor((Date.now() - 3 * DAY) / 1000) * 1000);
    await db.update(pollOptions).set({ startsAt: stale }).where(eq(pollOptions.pollId, poll.id));
    const now = new Date();
    await db
      .update(polls)
      .set({ closesAt: new Date(now.getTime() - 1000) })
      .where(eq(polls.id, poll.id));
    expect(await runPollsClose(deps, now)).toBe(1);
    const [ev] = await closedEvents(poll.id);
    const winnerAt = (ev!.payload as { winnerStartsAt: string }).winnerStartsAt;
    expect(Date.parse(winnerAt)).toBeGreaterThan(now.getTime());
    expect(winnerAt).toBe(nextWeeklyStart(KYIV, 1, 19 * 60, now).toISOString());
    await dispatchEvents(deps);
    const [n] = (
      await db.select().from(notifications).where(eq(notifications.userId, gm.id))
    ).filter((x) => x.type === 'poll.closed');
    expect(n!.payload).toMatchObject({ startsAt: winnerAt });
  });
});

describe('polls: notifications and opt-out', () => {
  it('members get «poll.created» (category schedule) with Telegram buttons; site and Telegram opt-out respected', async () => {
    const { gm, a, b, gameId } = await group();
    const c = await userWithAge(25, 'c');
    await join(gm, gameId, c);
    for (const [u, tg] of [
      [a, '7001'],
      [b, '7002'],
      [c, '7003'],
    ] as const) {
      await db.insert(authIdentities).values({ userId: u.id, provider: 'telegram', subject: tg });
    }
    const prefs = (await call('get', '/api/me/notification-prefs', b.cookie)).body;
    // b вимикає «Розклад» лише в Telegram, c — повністю (і на сайті).
    await call('put', '/api/me/notification-prefs', b.cookie, {
      ...prefs,
      telegram: { ...prefs.telegram, schedule: false },
    });
    await call('put', '/api/me/notification-prefs', c.cookie, {
      ...prefs,
      site: { schedule: false },
    });
    await dispatchEvents(deps);
    await db.delete(telegramOutbox);
    await db.delete(notifications);

    const poll = await createPoll(gm, gameId);
    await dispatchEvents(deps);
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'poll.created'))
      .orderBy(asc(notifications.userId));
    expect(rows.map((r) => r.userId)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ category: 'schedule', entityType: 'poll', entityId: poll.id });
    expect(rows[0]!.payload).toMatchObject({
      gameId,
      pollId: poll.id,
      pollKind: 'one_off',
      closesAt: poll.closesAt,
      pollOptions: poll.options.map((o) => ({ id: o.id, n: o.position, startsAt: o.startsAt })),
    });
    const outbox = await db.select().from(telegramOutbox);
    expect(outbox.map((o) => o.userId)).toEqual([a.id]);
    expect(outbox[0]!.buttons).toEqual(
      poll.options.flatMap((o) =>
        ['yes', 'no', 'maybe'].map((value) => ({
          action: 'vote',
          optionId: o.id,
          n: o.position,
          value,
        })),
      ),
    );
    const link = (await call('get', '/api/me/notifications', a.cookie)).body.items[0].link;
    expect(link).toBe(`/games/${gameId}?poll=${poll.id}`);
  });
});

describe('polls: apply (GM, closed only, idempotent)', () => {
  it('regular → new weekly rule through the schedule service; repeat apply is a no-op', async () => {
    const { gm, a, b, gameId } = await group();
    const target = ((first.weekday + 2) % 7) as Weekday;
    const poll = await createPoll(gm, gameId, {
      kind: 'regular',
      options: [
        { weekday: target, startMin: 18 * 60 + 30 },
        { weekday: first.weekday, startMin: 20 * 60 },
      ],
      closesAt: deadline(),
    });
    const o = poll.options[0]!;
    expect(o).toMatchObject({ weekday: target, startMin: 1110 });
    const z = toZoned(new Date(o.startsAt), KYIV);
    expect([z.weekday, z.hour, z.minute]).toEqual([target, 18, 30]);

    const open = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('POLL_OPEN');
    await votes(a, poll, ['yes', 'no']);
    await votes(b, poll, ['yes', 'maybe']);
    const res = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ kind: 'schedule' });
    expect(res.body.poll).toMatchObject({ appliedOptionId: o.id, appliedSessionId: null });
    const [g] = await db.select().from(games).where(eq(games.id, gameId));
    expect(g!.weekdays).toEqual([target]);
    const gz = toZoned(g!.startsAt!, KYIV);
    expect([gz.weekday, gz.hour, gz.minute]).toEqual([target, 18, 30]);
    expect(g!.startsAt!.getTime()).toBeGreaterThan(Date.now());

    const again = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {
      optionId: poll.options[1]!.id,
    });
    expect(again.status).toBe(200);
    expect(again.body.poll.appliedOptionId).toBe(o.id);
    const ruleEvents = await db.select().from(events).where(eq(events.type, 'game.rule_changed'));
    expect(ruleEvents).toHaveLength(1);
  });

  it('one-off with a target session → reschedules it; without → a manual campaign session; no winner → 409', async () => {
    const { gm, a, b, gameId } = await group();
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const [s] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt));
    const re = await createPoll(gm, gameId, oneOffBody({ sessionId: s!.id }));
    expect(re.sessionId).toBe(s!.id);
    await votes(a, re, ['no', 'yes']);
    await votes(b, re, ['maybe', 'yes']);
    const applied = await call('post', `/api/polls/${re.id}/apply`, gm.cookie);
    expect(applied.body.applied).toEqual({ kind: 'session', sessionId: s!.id });
    const [moved] = await db.select().from(gameSessions).where(eq(gameSessions.id, s!.id));
    expect(moved!.startsAt.toISOString()).toBe(re.options[1]!.startsAt);
    expect(moved!.rescheduled).toBe(true);

    const extra = await createPoll(gm, gameId);
    await votes(a, extra, ['yes', 'no']);
    await votes(b, extra, ['yes', 'no']);
    const r1 = await call('post', `/api/polls/${extra.id}/apply`, gm.cookie, {});
    const r2 = await call('post', `/api/polls/${extra.id}/apply`, gm.cookie, {});
    expect(r1.body.applied.kind).toBe('session');
    expect(r2.body.applied).toEqual(r1.body.applied);
    const manual = await db
      .select()
      .from(gameSessions)
      .where(and(eq(gameSessions.gameId, gameId), eq(gameSessions.origin, 'manual')));
    expect(manual).toHaveLength(1);
    expect(manual[0]!.startsAt.toISOString()).toBe(extra.options[0]!.startsAt);
    expect(manual[0]!.durationMinutes).toBe(240);

    const none = await createPoll(gm, gameId);
    await votes(a, none, ['no', 'no']);
    await votes(b, none, ['no', 'no']);
    const nw = await call('post', `/api/polls/${none.id}/apply`, gm.cookie, {});
    expect(nw.status).toBe(409);
    expect(nw.body.error.code).toBe('POLL_NO_WINNER');
    // Майстер може обрати варіант явно; помилка сервісу (час минув) знімає позначку застосування.
    await db
      .update(pollOptions)
      .set({ startsAt: new Date(Math.floor((Date.now() - DAY) / 60_000) * 60_000) })
      .where(eq(pollOptions.id, none.options[0]!.id));
    const past = await call('post', `/api/polls/${none.id}/apply`, gm.cookie, {
      optionId: none.options[0]!.id,
    });
    expect(past.status).toBe(422);
    expect((await pollRow(none.id)).appliedAt).toBeNull();
    const ok = await call('post', `/api/polls/${none.id}/apply`, gm.cookie, {
      optionId: none.options[1]!.id,
    });
    expect(ok.status).toBe(200);
  });

  it('oneshot one-off without a target → reschedules its single session', async () => {
    const gm = await userWithAge(30, 'gm');
    const a = await userWithAge(25, 'a');
    const gameId = await createGame(
      gm.cookie,
      { kind: 'oneshot', recurrence: 'none', weekdays: [], startsAt: first.iso },
      true,
    );
    await join(gm, gameId, a);
    const regular = await call('post', `/api/games/${gameId}/polls`, gm.cookie, {
      kind: 'regular',
      options: [
        { weekday: 1, startMin: 1140 },
        { weekday: 2, startMin: 1140 },
      ],
      closesAt: deadline(),
    });
    expect(regular.status).toBe(409);
    const poll = await createPoll(gm, gameId);
    await votes(a, poll, ['no', 'yes']);
    const res = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(res.status).toBe(200);
    const sessions = await db.select().from(gameSessions).where(eq(gameSessions.gameId, gameId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.startsAt.toISOString()).toBe(poll.options[1]!.startsAt);
    expect(res.body.applied).toEqual({ kind: 'session', sessionId: sessions[0]!.id });
  });
});

describe('polls: Telegram buttons (RF 2)', () => {
  const action = (body: Record<string, unknown>) =>
    request(app).post('/api/internal/telegram/action').set('X-Internal-Key', KEY).send(body);

  it('a linked member votes; non-members, closed polls and malformed payloads are refused', async () => {
    const { gm, a, b, stranger, gameId } = await group();
    for (const [u, tg] of [
      [a, '8001'],
      [stranger, '8002'],
      [gm, '8003'],
      [b, '8004'],
    ] as const) {
      await db.insert(authIdentities).values({ userId: u.id, provider: 'telegram', subject: tg });
    }
    const poll = await createPoll(gm, gameId);
    const optionId = poll.options[0]!.id;
    const ok = await action({ telegramId: '8001', action: 'vote', id: optionId, value: 'maybe' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, result: 'vote_maybe' });
    const changed = await action({ telegramId: 8001, action: 'vote', id: optionId, value: 'yes' });
    expect(changed.body.result).toBe('vote_yes');
    const stored = await db.select().from(pollVotes).where(eq(pollVotes.userId, a.id));
    expect(stored.map((v) => [v.optionId, v.value])).toEqual([[optionId, 'yes']]);

    for (const tg of ['8002', '8003']) {
      const r = await action({ telegramId: tg, action: 'vote', id: optionId, value: 'yes' });
      expect(r.status, tg).toBe(403);
      expect(r.body.error.code).toBe('NOT_A_MEMBER');
    }
    await call('post', `/api/games/${gameId}/leave`, b.cookie, LEAVE);
    const ex = await action({ telegramId: '8004', action: 'vote', id: optionId, value: 'yes' });
    expect(ex.status).toBe(403);
    expect(
      (await action({ telegramId: '8001', action: 'vote', id: 999_999, value: 'yes' })).status,
    ).toBe(404);
    for (const body of [
      { telegramId: '8001', action: 'vote', id: optionId },
      { telegramId: '8001', action: 'vote', id: optionId, value: 'going' },
      { telegramId: '8001', action: 'rsvp', id: optionId, value: 'yes' },
      { telegramId: '8001', action: 'approve', id: optionId, value: 'yes' },
      { telegramId: '8001', action: 'vote', id: -1, value: 'yes' },
    ]) {
      const r = await action(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // b вийшов, a відповів на перший варіант — ще не всі; закриваємо майстром.
    await call('post', `/api/polls/${poll.id}/close`, gm.cookie);
    const closed = await action({ telegramId: '8001', action: 'vote', id: optionId, value: 'no' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('POLL_CLOSED');
    expect((await db.select().from(pollVotes).where(eq(pollVotes.userId, a.id)))[0]!.value).toBe(
      'yes',
    );
  });
});

describe('polls: review fixes', () => {
  const regularBody = (weekday: Weekday, startMin = 20 * 60) => ({
    kind: 'regular',
    options: [
      { weekday, startMin },
      { weekday: ((weekday + 1) % 7) as Weekday, startMin },
    ],
    closesAt: deadline(),
  });

  it('multi-day campaign: apply asks to confirm the days; weekdays must include the option day', async () => {
    const second = ((first.weekday + 3) % 7) as Weekday;
    const { gm, a, b, gameId } = await group({ weekdays: [first.weekday, second].sort() });
    const target = ((first.weekday + 1) % 7) as Weekday;
    const poll = await createPoll(gm, gameId, regularBody(target));
    await votes(a, poll, ['yes', 'no']);
    await votes(b, poll, ['yes', 'no']);
    const ask = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(ask.status).toBe(409);
    expect(ask.body.error.code).toBe('POLL_APPLY_CONFIRM');
    expect(ask.body.error.details).toEqual({ currentWeekdays: [first.weekday, second].sort() });
    expect(await pollRow(poll.id)).toMatchObject({ appliedAt: null, applyingAt: null });
    const wrong = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {
      weekdays: [first.weekday, second],
    });
    expect(wrong.status).toBe(400);
    // «Додатково»: наявні дні + день варіанта, один час для всіх.
    const days = [first.weekday, second, target];
    const ok = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, { weekdays: days });
    expect(ok.status).toBe(200);
    const [g] = await db.select().from(games).where(eq(games.id, gameId));
    expect(g!.weekdays).toEqual([...days].sort((x, y) => x - y));
    const z = toZoned(g!.startsAt!, KYIV);
    expect([z.weekday, z.hour, z.minute]).toEqual([target, 20, 0]);
  });

  it('a new campaign session notifies members (session.created) with RSVP buttons', async () => {
    const { gm, a, b, gameId } = await group();
    await db.insert(authIdentities).values({ userId: a.id, provider: 'telegram', subject: '9101' });
    const poll = await createPoll(gm, gameId);
    await votes(a, poll, ['yes', 'no']);
    await votes(b, poll, ['yes', 'no']);
    await dispatchEvents(deps);
    await db.delete(telegramOutbox);
    const res = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    const sessionId = res.body.applied.sessionId as number;
    await dispatchEvents(deps);
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'session.created'))
      .orderBy(asc(notifications.userId));
    expect(rows.map((r) => r.userId)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ category: 'sessions', entityId: sessionId });
    expect(rows[0]!.payload).toMatchObject({ sessionId, startsAt: poll.options[0]!.startsAt });
    const [out] = await db.select().from(telegramOutbox);
    expect(out!.buttons).toEqual([
      { action: 'rsvp', sessionId, value: 'going' },
      { action: 'rsvp', sessionId, value: 'not_going' },
    ]);
  });

  it('a reschedule poll whose session is gone → 409 unless asNewSession', async () => {
    const { gm, a, b, gameId } = await group();
    await call('get', `/api/games/${gameId}/sessions`, gm.cookie);
    const [s] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.gameId, gameId))
      .orderBy(asc(gameSessions.startsAt));
    const poll = await createPoll(gm, gameId, oneOffBody({ sessionId: s!.id }));
    await votes(a, poll, ['yes', 'no']);
    await votes(b, poll, ['yes', 'no']);
    const c = await call('post', `/api/sessions/${s!.id}/cancel`, gm.cookie, { reason: 'Хворію' });
    expect(c.status).toBe(200);
    const refused = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SESSION_INVALID_STATE');
    expect(await pollRow(poll.id)).toMatchObject({ appliedAt: null, applyingAt: null });
    const forced = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {
      asNewSession: true,
    });
    expect(forced.status).toBe(200);
    expect(forced.body.applied.sessionId).not.toBe(s!.id);
    const [created] = await db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, forced.body.applied.sessionId));
    expect(created).toMatchObject({ origin: 'manual' });
  });

  it('paused campaign: create and vote allowed, apply → GAME_PAUSED', async () => {
    const { gm, a, b, gameId } = await group();
    expect((await call('post', `/api/games/${gameId}/start`, gm.cookie)).status).toBe(200);
    const pause = await call('post', `/api/games/${gameId}/pause`, gm.cookie, {
      reason: 'vacation',
    });
    expect(pause.status).toBe(200);
    const poll = await createPoll(gm, gameId, regularBody(first.weekday));
    expect((await votes(a, poll, ['yes', 'no'])).status).toBe(200);
    expect((await votes(b, poll, ['yes', 'no'])).status).toBe(200);
    const res = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GAME_PAUSED');
  });

  it('cancelled game: voting refused and closes the poll; the job closes the rest silently', async () => {
    const { gm, a, gameId } = await group();
    const p1 = await createPoll(gm, gameId);
    const p2 = await createPoll(gm, gameId);
    expect((await call('post', `/api/games/${gameId}/cancel`, gm.cookie)).status).toBe(200);
    const late = await votes(a, p1, ['yes', 'yes']);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('POLL_CLOSED');
    expect(await pollRow(p1.id)).toMatchObject({ status: 'closed', closeReason: 'game_closed' });
    expect(await runPollsClose(deps)).toBe(1);
    expect((await pollRow(p2.id)).closeReason).toBe('game_closed');
    await dispatchEvents(deps);
    const gmPoll = (
      await db.select().from(notifications).where(eq(notifications.userId, gm.id))
    ).filter((n) => n.type === 'poll.closed');
    expect(gmPoll).toEqual([]);
  });

  it('concurrent apply never reports a wrong result; a fresh claim blocks, a stale one is taken over', async () => {
    const { gm, a, b, gameId } = await group();
    const poll = await createPoll(gm, gameId);
    await votes(a, poll, ['yes', 'no']);
    await votes(b, poll, ['yes', 'no']);
    await db.update(polls).set({ applyingAt: new Date() }).where(eq(polls.id, poll.id));
    const pending = await call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {});
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('POLL_APPLY_PENDING');
    await db
      .update(polls)
      .set({ applyingAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(polls.id, poll.id));
    const [r1, r2] = await Promise.all([
      call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {}),
      call('post', `/api/polls/${poll.id}/apply`, gm.cookie, {}),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    for (const r of [r1, r2]) {
      if (r.status === 200) expect(r.body.applied.kind).toBe('session');
      else expect(r.body.error.code).toBe('POLL_APPLY_PENDING');
    }
    const manual = await db
      .select()
      .from(gameSessions)
      .where(and(eq(gameSessions.gameId, gameId), eq(gameSessions.origin, 'manual')));
    expect(manual).toHaveLength(1);
    expect(await pollRow(poll.id)).toMatchObject({ applyingAt: null });
  });

  it('one-off options must start after the deadline', async () => {
    const { gm, gameId } = await group();
    const r = await call(
      'post',
      `/api/games/${gameId}/polls`,
      gm.cookie,
      oneOffBody({ closesAt: kyivAt(5, 20).iso }),
    );
    expect(r.status).toBe(400);
  });

  it('live updates: «polls» ping to the members room on create, vote, close and apply', async () => {
    const pings: { room: string; payload: unknown }[] = [];
    const hub = {
      toRoom: (room: string, _e: string, payload: unknown) => pings.push({ room, payload }),
      toUser: () => {},
      joinRoom: () => {},
      leaveRoom: () => {},
      disconnectUser: () => {},
      disconnectSession: () => {},
    };
    const rt = { ...deps, realtime: hub } as unknown as typeof deps;
    const svc = await import('../../src/scheduling/polls.service.js');
    const { gm, a, b, gameId } = await group();
    const polled = () =>
      pings.filter(
        (p) =>
          p.room === `game-members:${gameId}` && (p.payload as { scope: string }).scope === 'polls',
      ).length;
    const poll = await svc.createPoll(rt, gm.id, gameId, oneOffBody());
    expect(polled()).toBe(1);
    await svc.vote(rt, a.id, poll.id, {
      votes: poll.options.map((o) => ({ optionId: o.id, value: 'yes' })),
    });
    expect(polled()).toBe(2);
    await svc.vote(rt, b.id, poll.id, {
      votes: poll.options.map((o) => ({ optionId: o.id, value: 'no' })),
    });
    expect(polled()).toBe(4); // голос + закриття «всі проголосували»
    await svc.applyPoll(rt, gm.id, poll.id, {});
    expect(polled()).toBe(5);
    const p2 = await svc.createPoll(rt, gm.id, gameId, oneOffBody());
    await svc.closePollByGm(rt, gm.id, p2.id);
    expect(polled()).toBe(7);
  });
});
