import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  nextWeeklyStart,
  pollApplySchema,
  pollCreateSchema,
  pollVotesSchema,
  pollWinner,
  POLL_MAX_DEADLINE_DAYS,
  POLL_MAX_OPEN_PER_GAME,
  type PollApplyResultDto,
  type PollCloseReason,
  type PollDto,
  type PollOptionDto,
  type PollVoteValue,
  type Weekday,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import {
  gameMembers,
  games,
  gameSessions,
  pollOptions,
  polls,
  pollVotes,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { changeScheduleRule } from '../games/games.service.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { materializeSessions } from '../sessions/materialize.js';
import { createManualSession, rescheduleSession } from '../sessions/sessions.service.js';
import { loadGmGame } from './common-times.service.js';

type GameRow = typeof games.$inferSelect;
type PollRow = typeof polls.$inferSelect;
type OptionRow = typeof pollOptions.$inferSelect;

const DAY_MS = 86_400_000;
/** Скільки останніх голосувань гри віддає список. */
const POLLS_LIST_LIMIT = 20;
/** Пачка відкритих голосувань, які перевіряє джоб закриття за один прохід. */
const CLOSE_BATCH = 200;

export const POLLS_CLOSE_JOB = 'polls.close';
export const POLLS_CLOSE_EVERY_MS = 60_000;

/** Голосувати й створювати голосування можна в іграх, що набирають, ідуть чи на паузі. */
const POLL_GAME_STATUSES: GameRow['status'][] = ['recruiting', 'started', 'paused'];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------- доступ ----------

async function activeMemberIds(deps: AppDeps, gameId: number): Promise<number[]> {
  const rows = await deps.db
    .select({ userId: gameMembers.userId })
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, gameId), isNull(gameMembers.leftAt)))
    .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id));
  return rows.map((r) => r.userId);
}

/**
 * Гра, голосування якої бачить `userId`: майстер або активний учасник. Невідома чи прихована
 * від не-майстра гра — 404; решта сторонніх (зокрема колишні учасники) — 403 `NOT_A_MEMBER`.
 */
async function loadViewableGame(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<{ game: GameRow; isGm: boolean }> {
  const [game] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!game) throw new AppError(404, 'NOT_FOUND');
  if (game.gmUserId === userId) return { game, isGm: true };
  if (isHiddenFromNonGm(game)) throw new AppError(404, 'NOT_FOUND');
  const [m] = await deps.db
    .select({ id: gameMembers.id })
    .from(gameMembers)
    .where(
      and(
        eq(gameMembers.gameId, gameId),
        eq(gameMembers.userId, userId),
        isNull(gameMembers.leftAt),
      ),
    );
  if (!m) throw new AppError(403, 'NOT_A_MEMBER');
  return { game, isGm: false };
}

async function loadPollRow(deps: AppDeps, pollId: number): Promise<PollRow> {
  const [p] = await deps.db.select().from(polls).where(eq(polls.id, pollId));
  if (!p) throw new AppError(404, 'NOT_FOUND');
  return p;
}

// ---------- DTO ----------

/** DTO кількох голосувань однієї гри: 4 запити незалежно від кількості. */
async function toDtos(
  deps: AppDeps,
  game: GameRow,
  rows: PollRow[],
  viewerId: number,
  now: Date,
): Promise<PollDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const memberIds = await activeMemberIds(deps, game.id);
  const [options, votes, people] = await Promise.all([
    deps.db
      .select()
      .from(pollOptions)
      .where(inArray(pollOptions.pollId, ids))
      .orderBy(asc(pollOptions.position)),
    deps.db.select().from(pollVotes).where(inArray(pollVotes.pollId, ids)),
    memberIds.length
      ? deps.db
          .select({ id: users.id, nickname: users.nickname })
          .from(users)
          .where(inArray(users.id, memberIds))
      : Promise.resolve([]),
  ]);
  const nick = new Map(people.map((p) => [p.id, p.nickname]));
  const active = new Set(memberIds);
  const isGm = game.gmUserId === viewerId;
  return rows.map((p) => {
    const opts = options.filter((o) => o.pollId === p.id);
    // Рахуються лише відповіді активних учасників (колишні не впливають на підсумок).
    const pv = votes.filter((v) => v.pollId === p.id && active.has(v.userId));
    const optionDtos: PollOptionDto[] = opts.map((o) => {
      const ov = pv.filter((v) => v.optionId === o.id);
      const n = (value: PollVoteValue) => ov.filter((v) => v.value === value).length;
      return {
        id: o.id,
        position: o.position,
        weekday: p.kind === 'regular' ? (o.weekday as Weekday) : null,
        startMin: p.kind === 'regular' ? o.startMin : null,
        startsAt: o.startsAt.toISOString(),
        yes: n('yes'),
        no: n('no'),
        maybe: n('maybe'),
        votes: ov
          .map((v) => ({ userId: v.userId, value: v.value }))
          .sort((a, b) => memberIds.indexOf(a.userId) - memberIds.indexOf(b.userId)),
      };
    });
    const answered = (u: number) => pv.filter((v) => v.userId === u).length;
    return {
      id: p.id,
      gameId: p.gameId,
      kind: p.kind,
      status: p.status,
      closeReason: p.closeReason ?? null,
      timezone: game.timezone,
      durationMinutes: p.durationMinutes,
      sessionId: p.sessionId ?? null,
      closesAt: p.closesAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
      closedAt: iso(p.closedAt),
      options: optionDtos,
      voters: memberIds.map((u) => ({
        userId: u,
        nickname: nick.get(u) ?? null,
        voted: answered(u) >= opts.length,
      })),
      winnerOptionId: pollWinner(optionDtos),
      appliedAt: iso(p.appliedAt),
      appliedOptionId: p.appliedOptionId ?? null,
      appliedSessionId: p.appliedSessionId ?? null,
      isGm,
      canVote: !isGm && active.has(viewerId) && p.status === 'open' && p.closesAt > now,
    };
  });
}

async function pollDto(deps: AppDeps, pollId: number, viewerId: number): Promise<PollDto> {
  const p = await loadPollRow(deps, pollId);
  const [game] = await deps.db.select().from(games).where(eq(games.id, p.gameId));
  return (await toDtos(deps, game!, [p], viewerId, new Date()))[0]!;
}

// ---------- створення ----------

/**
 * `POST /api/games/:id/polls` — лише майстер. Гра набирає, іде чи на паузі, має хоч одного
 * активного учасника; `regular` — лише кампейн; не більше `POLL_MAX_OPEN_PER_GAME` відкритих.
 * Учасникам — подія `poll.created` (сповіщення «Розклад», у Telegram — кнопки відповіді).
 */
export async function createPoll(
  deps: AppDeps,
  userId: number,
  gameId: number,
  body: unknown,
  now: Date = new Date(),
): Promise<PollDto> {
  const game = await loadGmGame(deps, userId, gameId);
  const input = pollCreateSchema.parse(body);
  if (!POLL_GAME_STATUSES.includes(game.status)) {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  if (input.kind === 'regular' && game.kind !== 'campaign') {
    throw new AppError(409, 'GAME_INVALID_TRANSITION');
  }
  const closesAt = new Date(input.closesAt);
  if (closesAt <= now || closesAt.getTime() > now.getTime() + POLL_MAX_DEADLINE_DAYS * DAY_MS) {
    throw new AppError(400, 'VALIDATION', { reason: 'DEADLINE_RANGE', path: ['closesAt'] });
  }
  if ((await activeMemberIds(deps, gameId)).length === 0) {
    throw new AppError(400, 'VALIDATION', { reason: 'NO_MEMBERS' });
  }
  const sessionId = input.kind === 'one_off' ? (input.sessionId ?? null) : null;
  if (sessionId !== null) {
    const [s] = await deps.db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
    if (!s || s.gameId !== gameId) {
      throw new AppError(400, 'VALIDATION', { reason: 'SESSION_NOT_IN_GAME', path: ['sessionId'] });
    }
    if (s.status !== 'scheduled') throw new AppError(409, 'SESSION_INVALID_STATE');
  }
  const optionRows =
    input.kind === 'regular'
      ? input.options.map((o) => ({
          weekday: o.weekday as Weekday,
          startMin: o.startMin,
          startsAt: nextWeeklyStart(game.timezone, o.weekday as Weekday, o.startMin, now),
        }))
      : input.options.map((o) => ({
          weekday: null,
          startMin: null,
          startsAt: new Date(o.startsAt),
        }));
  if (optionRows.some((o) => o.startsAt <= now)) {
    throw new AppError(422, 'GAME_IN_PAST');
  }
  const pollId = await deps.db.transaction(async (tx) => {
    // Під X-блокуванням гри: паралельні створення не перевищать ліміт відкритих.
    await tx.select({ id: games.id }).from(games).where(eq(games.id, gameId)).for('update');
    const [open] = await tx
      .select({ n: count() })
      .from(polls)
      .where(and(eq(polls.gameId, gameId), eq(polls.status, 'open')));
    if ((open?.n ?? 0) >= POLL_MAX_OPEN_PER_GAME) throw new AppError(409, 'POLL_LIMIT');
    const [res] = await tx
      .insert(polls)
      .values({
        gameId,
        kind: input.kind,
        sessionId,
        durationMinutes: game.durationMinutes,
        closesAt,
      })
      .$returningId();
    await tx
      .insert(pollOptions)
      .values(optionRows.map((o, i) => ({ pollId: res!.id, position: i + 1, ...o })));
    return res!.id;
  });
  const options = await deps.db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(asc(pollOptions.position));
  await logEvent(deps.db, {
    type: 'poll.created',
    userId,
    entityType: 'poll',
    entityId: pollId,
    payload: {
      gameId,
      kind: input.kind,
      closesAt: closesAt.toISOString(),
      options: options.map((o) => ({
        id: o.id,
        n: o.position,
        startsAt: o.startsAt.toISOString(),
      })),
    },
  });
  return pollDto(deps, pollId, userId);
}

// ---------- перегляд ----------

/** `GET /api/games/:id/polls` — майстер і активні учасники; відкриті першими, далі новіші. */
export async function listGamePolls(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<PollDto[]> {
  const { game } = await loadViewableGame(deps, userId, gameId);
  const rows = await deps.db
    .select()
    .from(polls)
    .where(eq(polls.gameId, gameId))
    .orderBy(sql`${polls.status} = 'open' desc`, desc(polls.id))
    .limit(POLLS_LIST_LIMIT);
  return toDtos(deps, game, rows, userId, new Date());
}

/** `GET /api/polls/:id` — майстер і активні учасники гри. */
export async function getPoll(deps: AppDeps, userId: number, pollId: number): Promise<PollDto> {
  const p = await loadPollRow(deps, pollId);
  const { game } = await loadViewableGame(deps, userId, p.gameId);
  return (await toDtos(deps, game, [p], userId, new Date()))[0]!;
}

// ---------- голосування ----------

/**
 * Відповіді учасника (`PUT /api/polls/:id/votes`, також Telegram-кнопки). Лише активний
 * учасник гри (не майстер; колишній — 403 `NOT_A_MEMBER`); голосування відкрите й дедлайн не
 * настав (інакше 409 `POLL_CLOSED`); варіанти — цього голосування (інакше 400). Відповідь
 * змінюється до закриття. Транзакція тримає S-блокування рядка голосування, тож закриття
 * (`UPDATE … WHERE status='open'`) не проскочить між перевіркою й записом. Після запису —
 * спроба закрити «всі проголосували».
 */
export async function vote(
  deps: AppDeps,
  userId: number,
  pollId: number,
  body: unknown,
  now: Date = new Date(),
): Promise<PollDto> {
  const input = pollVotesSchema.parse(body);
  const p = await loadPollRow(deps, pollId);
  const { isGm } = await loadViewableGame(deps, userId, p.gameId);
  if (isGm) throw new AppError(403, 'NOT_A_MEMBER');
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(polls).where(eq(polls.id, pollId)).for('share');
    if (!row || row.status !== 'open' || row.closesAt <= now) {
      throw new AppError(409, 'POLL_CLOSED');
    }
    const valid = new Set(
      (
        await tx
          .select({ id: pollOptions.id })
          .from(pollOptions)
          .where(eq(pollOptions.pollId, pollId))
      ).map((o) => o.id),
    );
    if (input.votes.some((v) => !valid.has(v.optionId))) {
      throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_OPTION', path: ['votes'] });
    }
    await tx
      .insert(pollVotes)
      .values(input.votes.map((v) => ({ optionId: v.optionId, userId, pollId, value: v.value })))
      .onDuplicateKeyUpdate({ set: { value: sql`VALUES(${pollVotes.value})` } });
  });
  if (await allVoted(deps, p.id, p.gameId)) await closePoll(deps, p.id, 'all_voted', null, now);
  return pollDto(deps, pollId, userId);
}

/** Варіант голосування → голосування (для Telegram-кнопки `v:<optionId>:…`). */
export async function pollIdOfOption(deps: AppDeps, optionId: number): Promise<number> {
  const [o] = await deps.db
    .select({ pollId: pollOptions.pollId })
    .from(pollOptions)
    .where(eq(pollOptions.id, optionId));
  if (!o) throw new AppError(404, 'NOT_FOUND');
  return o.pollId;
}

/** Кожен активний учасник відповів на кожен варіант (учасників немає — ні). */
async function allVoted(deps: AppDeps, pollId: number, gameId: number): Promise<boolean> {
  const members = await activeMemberIds(deps, gameId);
  if (members.length === 0) return false;
  const [opts] = await deps.db
    .select({ n: count() })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId));
  const [votes] = await deps.db
    .select({ n: count() })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), inArray(pollVotes.userId, members)));
  return (votes?.n ?? 0) >= members.length * (opts?.n ?? 0);
}

// ---------- закриття ----------

/**
 * Закриває відкрите голосування умовним `UPDATE`: лише той, хто його змінив, пише подію
 * `poll.closed` (майстру — сповіщення з підсумком, якщо закрилось само). Повторний чи
 * паралельний виклик — no-op. Повертає, чи закрив саме цей виклик.
 */
export async function closePoll(
  deps: AppDeps,
  pollId: number,
  reason: PollCloseReason,
  actorId: number | null,
  now: Date = new Date(),
): Promise<boolean> {
  const [res] = await deps.db
    .update(polls)
    .set({ status: 'closed', closeReason: reason, closedAt: now })
    .where(and(eq(polls.id, pollId), eq(polls.status, 'open')));
  if (res.affectedRows !== 1) return false;
  const p = await loadPollRow(deps, pollId);
  const [game] = await deps.db.select().from(games).where(eq(games.id, p.gameId));
  const dto = (await toDtos(deps, game!, [p], game!.gmUserId, now))[0]!;
  const winner = dto.options.find((o) => o.id === dto.winnerOptionId);
  await logEvent(deps.db, {
    type: 'poll.closed',
    userId: actorId,
    entityType: 'poll',
    entityId: pollId,
    payload: {
      gameId: p.gameId,
      kind: p.kind,
      reason,
      ...(winner ? { winnerStartsAt: winner.startsAt } : {}),
    },
  });
  return true;
}

/** `POST /api/polls/:id/close` — лише майстер; уже закрите — поточний стан (ідемпотентно). */
export async function closePollByGm(
  deps: AppDeps,
  userId: number,
  pollId: number,
): Promise<PollDto> {
  const p = await loadPollRow(deps, pollId);
  await loadGmGame(deps, userId, p.gameId);
  await closePoll(deps, pollId, 'gm', userId);
  return pollDto(deps, pollId, userId);
}

/**
 * Джоб `polls.close` (щохвилини): закриває відкриті голосування, чий дедлайн настав
 * (`deadline`), і ті, де вже відповіли всі активні учасники (`all_voted` — напр. після виходу
 * учасника, що не голосував). Ідемпотентно: закриття — умовний `UPDATE`, повторний прохід
 * чи паралельний воркер нічого не дублює.
 */
export async function runPollsClose(deps: AppDeps, now: Date = new Date()): Promise<number> {
  let closed = 0;
  const due = await deps.db
    .select({ id: polls.id })
    .from(polls)
    .where(and(eq(polls.status, 'open'), lte(polls.closesAt, now)))
    .orderBy(asc(polls.closesAt))
    .limit(CLOSE_BATCH);
  for (const p of due) if (await closePoll(deps, p.id, 'deadline', null, now)) closed++;
  const open = await deps.db
    .select({ id: polls.id, gameId: polls.gameId })
    .from(polls)
    .where(eq(polls.status, 'open'))
    .orderBy(asc(polls.closesAt))
    .limit(CLOSE_BATCH);
  for (const p of open) {
    if (
      (await allVoted(deps, p.id, p.gameId)) &&
      (await closePoll(deps, p.id, 'all_voted', null, now))
    ) {
      closed++;
    }
  }
  return closed;
}

// ---------- застосування ----------

/**
 * `POST /api/polls/:id/apply` — лише майстер, лише закрите голосування; варіант — `optionId`
 * або переможець (немає — 409 `POLL_NO_WINNER`). Застосовує наявними сервісами (їхні перевірки
 * й події): `regular` — нове правило розкладу (`changeScheduleRule`: щотижня або раз на два
 * тижні, якщо гра вже так, один день — день варіанта, перша сесія — найближча майбутня);
 * `one_off` — перенесення цільової сесії (`rescheduleSession`), для ваншота без неї — його
 * єдиної сесії, для кампейну без неї — нова разова сесія (`createManualSession`).
 * Ідемпотентно: `applied_at` ставиться умовним `UPDATE` до виклику сервісу (повтор чи
 * паралельний запит повертає поточний стан), а помилка сервісу його знімає.
 */
export async function applyPoll(
  deps: AppDeps,
  userId: number,
  pollId: number,
  body: unknown,
): Promise<PollApplyResultDto> {
  const input = pollApplySchema.parse(body ?? {});
  const p = await loadPollRow(deps, pollId);
  const game = await loadGmGame(deps, userId, p.gameId);
  const resultOf = (row: PollRow, dto: PollDto): PollApplyResultDto => ({
    poll: dto,
    applied:
      row.kind === 'regular' || row.appliedSessionId === null
        ? { kind: 'schedule' }
        : { kind: 'session', sessionId: row.appliedSessionId },
  });
  if (p.appliedAt) return resultOf(p, await pollDto(deps, pollId, userId));
  if (p.status !== 'closed') throw new AppError(409, 'POLL_OPEN');
  const dto = await pollDto(deps, pollId, userId);
  const optionId = input.optionId ?? dto.winnerOptionId;
  if (optionId === null) throw new AppError(409, 'POLL_NO_WINNER');
  const [option] = await deps.db
    .select()
    .from(pollOptions)
    .where(and(eq(pollOptions.id, optionId), eq(pollOptions.pollId, pollId)));
  if (!option) {
    throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_OPTION', path: ['optionId'] });
  }
  const [claim] = await deps.db
    .update(polls)
    .set({ appliedAt: new Date(), appliedOptionId: optionId })
    .where(and(eq(polls.id, pollId), eq(polls.status, 'closed'), isNull(polls.appliedAt)));
  if (claim.affectedRows !== 1) {
    const fresh = await loadPollRow(deps, pollId);
    return resultOf(fresh, await pollDto(deps, pollId, userId));
  }
  let sessionId: number | null = null;
  try {
    sessionId = await applyOption(deps, userId, game, p, option);
  } catch (err) {
    await deps.db
      .update(polls)
      .set({ appliedAt: null, appliedOptionId: null })
      .where(eq(polls.id, pollId));
    throw err;
  }
  if (sessionId !== null) {
    await deps.db.update(polls).set({ appliedSessionId: sessionId }).where(eq(polls.id, pollId));
  }
  const fresh = await loadPollRow(deps, pollId);
  return resultOf(fresh, await pollDto(deps, pollId, userId));
}

/** Виконує варіант; повертає сесію (разовий варіант) або `null` (новий розклад). */
async function applyOption(
  deps: AppDeps,
  userId: number,
  game: GameRow,
  poll: PollRow,
  option: OptionRow,
): Promise<number | null> {
  if (poll.kind === 'regular') {
    const weekday = option.weekday as Weekday;
    const startsAt = nextWeeklyStart(game.timezone, weekday, option.startMin ?? 0, new Date());
    await changeScheduleRule(
      deps,
      userId,
      game.id,
      {
        startsAt: startsAt.toISOString(),
        recurrence: game.recurrence === 'biweekly' ? 'biweekly' : 'weekly',
        weekdays: [weekday],
      },
      'schedule',
    );
    return null;
  }
  const startsAt = option.startsAt.toISOString();
  let target = poll.sessionId;
  if (target === null && game.kind === 'oneshot') {
    // Ваншот: його єдина запланована сесія (матеріалізуємо, якщо ще немає).
    await materializeSessions(deps, game.id);
    const [s] = await deps.db
      .select({ id: gameSessions.id })
      .from(gameSessions)
      .where(and(eq(gameSessions.gameId, game.id), eq(gameSessions.status, 'scheduled')))
      .orderBy(asc(gameSessions.startsAt))
      .limit(1);
    if (!s) throw new AppError(409, 'SESSION_INVALID_STATE');
    target = s.id;
  }
  if (target === null) return (await createManualSession(deps, userId, game.id, startsAt)).id;
  await rescheduleSession(deps, userId, target, { startsAt });
  return target;
}
