import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
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
import { emitGameChanged } from '../realtime/game-rooms.js';
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
  pollsChanged(deps, gameId);
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
 * учасник гри (не майстер; колишній — 403 `NOT_A_MEMBER`); голосування відкрите, дедлайн не
 * настав і гра ще набирає, іде чи на паузі (інакше 409 `POLL_CLOSED`; голосування завершеної
 * чи скасованої гри одразу закривається як `game_closed`); варіанти — цього голосування
 * (інакше 400). Відповідь змінюється до закриття. Транзакція тримає S-блокування рядків гри й
 * голосування, тож закриття (`UPDATE … WHERE status='open'`) і перехід гри не проскочать між
 * перевіркою й записом. Після запису — спроба закрити «всі проголосували».
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
  let gameEnded = false;
  try {
    await deps.db.transaction(async (tx) => {
      const [g] = await tx
        .select({ status: games.status })
        .from(games)
        .where(eq(games.id, p.gameId))
        .for('share');
      if (!g || !POLL_GAME_STATUSES.includes(g.status)) {
        gameEnded = true;
        throw new AppError(409, 'POLL_CLOSED');
      }
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
  } catch (err) {
    if (gameEnded) await closePoll(deps, pollId, 'game_closed', null, now);
    throw err;
  }
  pollsChanged(deps, p.gameId);
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
 * `poll.closed` (майстру — сповіщення з підсумком, якщо закрилось само; `game_closed` — без
 * сповіщення) і пінгує `polls`. Повторний чи паралельний виклик — no-op. Повертає, чи закрив
 * саме цей виклик.
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
  pollsChanged(deps, p.gameId);
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
 * Джоб `polls.close` (щохвилини): закриває відкриті голосування завершених чи скасованих ігор
 * (`game_closed`), ті, чий дедлайн настав (`deadline`), і ті, де вже відповіли всі активні
 * учасники (`all_voted` — напр. після виходу учасника, що не голосував). Ідемпотентно:
 * закриття — умовний `UPDATE`, повторний прохід чи паралельний воркер нічого не дублює.
 */
export async function runPollsClose(deps: AppDeps, now: Date = new Date()): Promise<number> {
  let closed = 0;
  const ended = await deps.db
    .select({ id: polls.id })
    .from(polls)
    .innerJoin(games, eq(games.id, polls.gameId))
    .where(and(eq(polls.status, 'open'), notInArray(games.status, POLL_GAME_STATUSES)))
    .limit(CLOSE_BATCH);
  for (const p of ended) if (await closePoll(deps, p.id, 'game_closed', null, now)) closed++;
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

/** Позначка «застосування триває», старша за це, вважається покинутою (збій процесу). */
export const POLL_APPLY_STALE_MS = 5 * 60_000;

/** Що саме застосувати — вирішено до захоплення (усі відмови — без побічних ефектів). */
type ApplyPlan =
  | { kind: 'schedule'; weekday: Weekday; startMin: number; weekdays: Weekday[] }
  | { kind: 'reschedule'; sessionId: number; startsAt: string }
  | { kind: 'oneshot'; startsAt: string }
  | { kind: 'new_session'; startsAt: string };

/**
 * `POST /api/polls/:id/apply` — лише майстер, лише закрите голосування; варіант — `optionId`
 * або переможець (немає — 409 `POLL_NO_WINNER`); кампейн на паузі — 409 `GAME_PAUSED`
 * (спершу відновлення). Застосовує наявними сервісами (їхні перевірки й події):
 * - `regular` — нове правило розкладу (`changeScheduleRule`): щотижня або раз на два тижні,
 *   якщо гра вже так; дні — `weekdays` (мають містити день варіанта) або, якщо в грі ≤ 1 дня,
 *   день варіанта; кілька днів без `weekdays` — 409 `POLL_APPLY_CONFIRM` з
 *   `details.currentWeekdays`. У правила один час початку — час варіанта стає часом усіх днів.
 *   Перша сесія — найближча майбутня в день варіанта.
 * - `one_off` з цільовою сесією — її перенесення (`rescheduleSession`); сесії вже немає чи вона
 *   не запланована — 409 `SESSION_INVALID_STATE`, якщо не передано `asNewSession: true`.
 * - `one_off` без цілі — для ваншота його єдина сесія, для кампейну нова разова сесія
 *   (`createManualSession`, подія `session.created`).
 *
 * Ідемпотентність і паралельність: захоплення — умовний `UPDATE` (`applying_at`, лише якщо
 * `applied_at IS NULL` і немає свіжого захоплення); паралельний виклик під час застосування —
 * 409 `POLL_APPLY_PENDING`; після — поточний результат. Фіналізація одним `UPDATE` пише
 * `applied_at`, варіант і сесію разом, тож результат ніколи не буває «напівзаписаним».
 * Помилка сервісу знімає захоплення. Лишається вікно збою: процес упав після сервісу, але до
 * фіналізації — через `POLL_APPLY_STALE_MS` захоплення вважається покинутим, і повтор виконає
 * сервіс удруге (новий розклад/перенесення ідемпотентні за змістом; разова сесія кампейну
 * може задублюватись).
 */
export async function applyPoll(
  deps: AppDeps,
  userId: number,
  pollId: number,
  body: unknown,
  now: Date = new Date(),
): Promise<PollApplyResultDto> {
  const input = pollApplySchema.parse(body ?? {});
  const p = await loadPollRow(deps, pollId);
  const game = await loadGmGame(deps, userId, p.gameId);
  if (p.appliedAt) return resultOf(deps, p, userId);
  if (p.status !== 'closed') throw new AppError(409, 'POLL_OPEN');
  if (p.applyingAt && p.applyingAt.getTime() > now.getTime() - POLL_APPLY_STALE_MS) {
    throw new AppError(409, 'POLL_APPLY_PENDING');
  }
  if (game.status === 'paused') throw new AppError(409, 'GAME_PAUSED');
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
  const plan = await planApply(deps, game, p, option, input);
  const [claim] = await deps.db
    .update(polls)
    .set({ applyingAt: now })
    .where(
      and(
        eq(polls.id, pollId),
        eq(polls.status, 'closed'),
        isNull(polls.appliedAt),
        or(
          isNull(polls.applyingAt),
          lt(polls.applyingAt, new Date(now.getTime() - POLL_APPLY_STALE_MS)),
        ),
      ),
    );
  if (claim.affectedRows !== 1) {
    const fresh = await loadPollRow(deps, pollId);
    if (fresh.appliedAt) return resultOf(deps, fresh, userId);
    throw new AppError(409, 'POLL_APPLY_PENDING');
  }
  let sessionId: number | null;
  try {
    sessionId = await runPlan(deps, userId, game, plan);
  } catch (err) {
    await deps.db.update(polls).set({ applyingAt: null }).where(eq(polls.id, pollId));
    throw err;
  }
  await deps.db
    .update(polls)
    .set({
      appliedAt: new Date(),
      appliedOptionId: optionId,
      appliedSessionId: sessionId,
      applyingAt: null,
    })
    .where(eq(polls.id, pollId));
  pollsChanged(deps, p.gameId);
  return resultOf(deps, await loadPollRow(deps, pollId), userId);
}

async function resultOf(deps: AppDeps, row: PollRow, userId: number): Promise<PollApplyResultDto> {
  return {
    poll: await pollDto(deps, row.id, userId),
    applied:
      row.appliedSessionId === null
        ? { kind: 'schedule' }
        : { kind: 'session', sessionId: row.appliedSessionId },
  };
}

/** Перевірки до захоплення: що застосовувати, або відмова (409/400) без побічних ефектів. */
async function planApply(
  deps: AppDeps,
  game: GameRow,
  poll: PollRow,
  option: OptionRow,
  input: { weekdays?: Weekday[]; asNewSession?: boolean },
): Promise<ApplyPlan> {
  if (poll.kind === 'regular') {
    const weekday = option.weekday as Weekday;
    const current = game.weekdays as Weekday[];
    let weekdays = input.weekdays;
    if (weekdays) {
      if (!weekdays.includes(weekday)) {
        throw new AppError(400, 'VALIDATION', {
          reason: 'WEEKDAYS_MISSING_OPTION',
          path: ['weekdays'],
        });
      }
    } else if (current.length <= 1) {
      weekdays = [weekday];
    } else {
      throw new AppError(409, 'POLL_APPLY_CONFIRM', { currentWeekdays: current });
    }
    return { kind: 'schedule', weekday, startMin: option.startMin ?? 0, weekdays };
  }
  const startsAt = option.startsAt.toISOString();
  if (poll.sessionId !== null) {
    const [s] = await deps.db
      .select({ gameId: gameSessions.gameId, status: gameSessions.status })
      .from(gameSessions)
      .where(eq(gameSessions.id, poll.sessionId));
    if (s && s.gameId === game.id && s.status === 'scheduled') {
      return { kind: 'reschedule', sessionId: poll.sessionId, startsAt };
    }
    // Намір був перенести саме цю сесію — без явної згоди нову не створюємо.
    if (!input.asNewSession) throw new AppError(409, 'SESSION_INVALID_STATE');
  }
  return game.kind === 'oneshot'
    ? { kind: 'oneshot', startsAt }
    : { kind: 'new_session', startsAt };
}

/** Виконує план; повертає сесію (разовий варіант) або `null` (новий розклад). */
async function runPlan(
  deps: AppDeps,
  userId: number,
  game: GameRow,
  plan: ApplyPlan,
): Promise<number | null> {
  switch (plan.kind) {
    case 'schedule': {
      const startsAt = nextWeeklyStart(game.timezone, plan.weekday, plan.startMin, new Date());
      await changeScheduleRule(
        deps,
        userId,
        game.id,
        {
          startsAt: startsAt.toISOString(),
          recurrence: game.recurrence === 'biweekly' ? 'biweekly' : 'weekly',
          weekdays: plan.weekdays,
        },
        'schedule',
      );
      return null;
    }
    case 'reschedule':
      await rescheduleSession(deps, userId, plan.sessionId, { startsAt: plan.startsAt });
      return plan.sessionId;
    case 'oneshot': {
      // Ваншот: його єдина запланована сесія (матеріалізуємо, якщо ще немає).
      await materializeSessions(deps, game.id);
      const [s] = await deps.db
        .select({ id: gameSessions.id })
        .from(gameSessions)
        .where(and(eq(gameSessions.gameId, game.id), eq(gameSessions.status, 'scheduled')))
        .orderBy(asc(gameSessions.startsAt))
        .limit(1);
      if (!s) throw new AppError(409, 'SESSION_INVALID_STATE');
      await rescheduleSession(deps, userId, s.id, { startsAt: plan.startsAt });
      return s.id;
    }
    case 'new_session':
      return (await createManualSession(deps, userId, game.id, plan.startsAt)).id;
  }
}

/** Голосування гри змінились: пінг `polls` майстру й активним учасникам. */
function pollsChanged(deps: AppDeps, gameId: number): void {
  emitGameChanged(deps, gameId, 'polls', 'members');
}
