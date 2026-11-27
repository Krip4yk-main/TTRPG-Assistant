import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, notExists, or } from 'drizzle-orm';
import {
  cancelSessionInputSchema,
  finishSessionInputSchema,
  rescheduleSessionInputSchema,
  sessionSummaryInputSchema,
  summaryExcerpt,
  type SeenState,
  type SessionDto,
  windowEnd,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import {
  gameBans,
  gameMembers,
  games,
  gameSessions,
  sessionAttendance,
  sessionRsvp,
  users,
} from '../db/schema/index.js';
import { logEvent } from '../events/events.service.js';
import { keepUpdatedAt } from '../games/dead-games/rules.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import {
  createNotification,
  dropSiteMuted,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { materializeSessions, sessionsWindow } from './materialize.js';
import { sessionsChanged } from '../realtime/game-rooms.js';
import { markGameSessionsViewed, markOwnChange, seenFor } from '../views/views.service.js';
import { rsvpOf, rsvpViews, type RsvpView } from './rsvp.js';
import { clearRsvpDeclines } from '../scheduling/reschedule.service.js';

type GameRow = typeof games.$inferSelect;
type SessionRow = typeof gameSessions.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const NO_RSVP: RsvpView = { myRsvp: null, rsvpSummary: null };

export function toSessionDto(s: SessionRow, seen: SeenState, rsvp: RsvpView = NO_RSVP): SessionDto {
  return {
    id: s.id,
    gameId: s.gameId,
    startsAt: s.startsAt.toISOString(),
    durationMinutes: s.durationMinutes,
    startWindowMinutes: s.startWindowMinutes,
    status: s.status,
    origin: s.origin,
    rescheduled: s.rescheduled,
    cancelReason: s.cancelReason,
    summary: s.summary,
    summarySentAt: iso(s.summarySentAt),
    doneAt: iso(s.doneAt),
    myRsvp: rsvp.myRsvp,
    rsvpSummary: rsvp.rsvpSummary,
    seen,
  };
}

const isRunning = (g: GameRow): boolean => g.status === 'recruiting' || g.status === 'started';

async function isActiveMember(deps: AppDeps, gameId: number, userId: number): Promise<boolean> {
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
  return Boolean(m);
}

/**
 * Сесії гри — майстру й активним учасникам (минулі 30 діб і всі майбутні); перед читанням
 * вікно матеріалізації зсувається до «зараз». Прихована гра для не-майстра → 404,
 * сторонній чи колишній учасник → 403 `NOT_A_MEMBER`.
 */
export async function listGameSessions(
  deps: AppDeps,
  userId: number,
  gameId: number,
): Promise<SessionDto[]> {
  const [g] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.gmUserId !== userId) {
    if (isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
    if (!(await isActiveMember(deps, gameId, userId))) throw new AppError(403, 'NOT_A_MEMBER');
  }
  const now = new Date();
  if ((await materializeSessions(deps, gameId, now)) > 0) sessionsChanged(deps, gameId);
  const rows = await deps.db
    .select()
    .from(gameSessions)
    .where(sessionsWindow(gameId, now))
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));
  const [views, seen] = await Promise.all([
    rsvpViews(
      deps,
      userId,
      g,
      rows.map((r) => r.id),
    ),
    seenFor(deps, userId, 'session', rows),
  ]);
  return rows.map((r) => toSessionDto(r, seen.get(r.id) ?? 'new', rsvpOf(views, r.id)));
}

// ---------- дії майстра над сесією ----------

/** Сесія й гра без блокувань — для перевірки доступу до транзакції. */
async function loadForGm(deps: AppDeps, userId: number, sessionId: number): Promise<GameRow> {
  const [r] = await deps.db
    .select({ game: games })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  if (r.game.gmUserId !== userId) {
    if (isHiddenFromNonGm(r.game)) throw new AppError(404, 'NOT_FOUND');
    throw new AppError(403, 'FORBIDDEN');
  }
  return r.game;
}

/**
 * Блокування в порядку гра (FOR SHARE) → сесія (FOR UPDATE). Гра має набирати чи йти,
 * сесія — бути `scheduled`.
 */
async function lockScheduled(
  tx: Tx,
  gameId: number,
  sessionId: number,
): Promise<{ game: GameRow; session: SessionRow }> {
  const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
  if (!game) throw new AppError(404, 'NOT_FOUND');
  if (!isRunning(game)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
  const [session] = await tx
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.id, sessionId))
    .for('update');
  if (!session) throw new AppError(404, 'NOT_FOUND');
  if (session.status !== 'scheduled') throw new AppError(409, 'SESSION_INVALID_STATE');
  return { game, session };
}

/**
 * Сесія з RSVP-частиною для глядача (`userId`), без перевірки доступу — викликати лише після
 * неї (дії майстра, RSVP учасника).
 */
export async function reload(
  deps: AppDeps,
  userId: number,
  sessionId: number,
): Promise<SessionDto> {
  const [r] = await deps.db
    .select({ s: gameSessions, gmUserId: games.gmUserId })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  const [views, seen] = await Promise.all([
    rsvpViews(deps, userId, { id: r.s.gameId, gmUserId: r.gmUserId }, [sessionId]),
    seenFor(deps, userId, 'session', [r.s]),
  ]);
  return toSessionDto(r.s, seen.get(sessionId) ?? 'new', rsvpOf(views, sessionId));
}

/** Після коміту дії майстра: власна зміна не «оновлення» для нього; пінги учасникам. */
async function afterGmSessionChange(
  deps: AppDeps,
  userId: number,
  gameId: number,
  sessionId: number,
): Promise<void> {
  await markOwnChange(deps, userId, 'session', [sessionId]);
  sessionsChanged(deps, gameId);
}

/**
 * Перенесення: новий час (ціла хвилина, у майбутньому), за бажанням — тривалість і вікно
 * початку (`startWindowMinutes`; без поля — лишається поточне, `null` — точний час). «Уточнити
 * час» сесії з вікном — це перенесення на точний час; він може бути будь-яким усередині вікна,
 * навіть минулим (тоді RSVP лишаються, а учасники не отримують сповіщення — подія з
 * `pastPin`). Нагадування майстру уточнити час
 * (`session.time_unpinned`) після перенесення — знову за новим часом.
 */
export async function rescheduleSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = rescheduleSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  const now = new Date();
  const startsAt = new Date(input.startsAt);
  const { from, pastPin } = await deps.db.transaction(async (tx) => {
    const { session } = await lockScheduled(tx, g.id, sessionId);
    // Уточнення часу (вікно → точний) — будь-який момент усередині вікна, навіть якщо вікно
    // вже почалось чи минуло (сесію зіграли, а час уточнюють потім); інакше — лише майбутнє.
    const pinInWindow =
      input.startWindowMinutes === null &&
      session.startWindowMinutes !== null &&
      startsAt >= session.startsAt &&
      startsAt <= windowEnd(session.startsAt, session.startWindowMinutes);
    if (startsAt <= now && !pinInWindow) throw new AppError(422, 'GAME_IN_PAST');
    const pastPin = startsAt <= now;
    await tx
      .update(gameSessions)
      .set({
        startsAt,
        rescheduled: true,
        unpinnedRemindedAt: null,
        ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.startWindowMinutes !== undefined
          ? { startWindowMinutes: input.startWindowMinutes }
          : {}),
      })
      .where(eq(gameSessions.id, sessionId));
    // RSVP відповідали на старий час — після перенесення учасники відповідають наново.
    // Уточнення вже зіграного (почалось) часу — лише запис факту: RSVP лишаються.
    if (!pastPin) {
      await tx.delete(sessionRsvp).where(eq(sessionRsvp.sessionId, sessionId));
      await clearRsvpDeclines(tx, sessionId);
    }
    return { from: session, pastPin };
  });
  await logEvent(deps.db, {
    type: 'session.rescheduled',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: {
      gameId: g.id,
      from: from.startsAt.toISOString(),
      to: startsAt.toISOString(),
      durationMinutes: input.durationMinutes ?? from.durationMinutes,
      // Вікна початку до й після (`null` — точний час): сповіщення показує вікно чи точний час.
      fromWindowMinutes: from.startWindowMinutes,
      startWindowMinutes:
        input.startWindowMinutes !== undefined ? input.startWindowMinutes : from.startWindowMinutes,
      // Уточнення часу, що вже настав: учасників не сповіщаємо (сесія вже йде чи минула).
      ...(pastPin ? { pastPin: true } : {}),
    },
  });
  await afterGmSessionChange(deps, userId, g.id, sessionId);
  return reload(deps, userId, sessionId);
}

/**
 * Додаткова разова сесія кампейну (`origin='manual'`, без слоту правила) — застосування
 * разового голосування за час без цільової сесії (Plan 12). Лише майстер (перевіряє
 * викликач), гра набирає чи йде, час — ціла хвилина в майбутньому; тривалість — з гри;
 * `startWindowMinutes` — вікно початку (`null` — точний час).
 * Подія `session.created` — учасникам сповіщення з RSVP-кнопками в Telegram.
 */
export async function createManualSession(
  deps: AppDeps,
  userId: number,
  gameId: number,
  startsAtIso: string,
  startWindowMinutes: number | null = null,
): Promise<SessionDto> {
  const { startsAt: iso, startWindowMinutes: window = null } = rescheduleSessionInputSchema.parse({
    startsAt: startsAtIso,
    startWindowMinutes,
  });
  const startsAt = new Date(iso);
  if (startsAt <= new Date()) throw new AppError(422, 'GAME_IN_PAST');
  const sessionId = await deps.db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId)).for('share');
    if (!game) throw new AppError(404, 'NOT_FOUND');
    if (game.gmUserId !== userId) throw new AppError(403, 'FORBIDDEN');
    if (!isRunning(game)) throw new AppError(409, 'GAME_INVALID_TRANSITION');
    const [res] = await tx
      .insert(gameSessions)
      .values({
        gameId,
        startsAt,
        durationMinutes: game.durationMinutes,
        startWindowMinutes: window,
        origin: 'manual',
        ruleStartsAt: null,
      })
      .$returningId();
    return res!.id;
  });
  await logEvent(deps.db, {
    type: 'session.created',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: { gameId, startsAt: startsAt.toISOString(), startWindowMinutes: window },
  });
  await afterGmSessionChange(deps, userId, gameId, sessionId);
  return reload(deps, userId, sessionId);
}

/** Скасування окремої сесії з причиною. */
export async function cancelSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = cancelSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  await deps.db.transaction(async (tx) => {
    await lockScheduled(tx, g.id, sessionId);
    await tx
      .update(gameSessions)
      .set({ status: 'cancelled', cancelReason: input.reason })
      .where(eq(gameSessions.id, sessionId));
  });
  await logEvent(deps.db, {
    type: 'session.cancelled',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: { gameId: g.id, reason: input.reason },
  });
  await afterGmSessionChange(deps, userId, g.id, sessionId);
  return reload(deps, userId, sessionId);
}

/**
 * Завершення сесії, що вже почалась (з точним часом; з вікном — 409
 * `SESSION_TIME_APPROXIMATE`): присутність активних учасників + необов'язковий
 * підсумок (бачать лише майстер і активні учасники); `sendSummary` — одразу надіслати його
 * учасникам (як `sendSessionSummary`; без підсумку → 422 `SUMMARY_EMPTY`). Невідомий чи
 * колишній учасник у присутності → 400. Після завершення вікно матеріалізації зсувається.
 */
export async function finishSession(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = finishSessionInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  if (input.sendSummary && !input.summary) throw new AppError(422, 'SUMMARY_EMPTY');
  const now = new Date();
  let sent: NotificationRow[] = [];
  const attendance = await deps.db.transaction(async (tx) => {
    const { session } = await lockScheduled(tx, g.id, sessionId);
    // Сесію з приблизним часом спершу треба уточнити (перенесенням на точний час).
    if (session.startWindowMinutes !== null) {
      throw new AppError(409, 'SESSION_TIME_APPROXIMATE', { sessionId });
    }
    if (session.startsAt > now) throw new AppError(409, 'SESSION_INVALID_STATE');
    // FOR SHARE гри блокує лише виключення/бан (беруть X). Склад не заморожено: вихід із
    // гри (теж FOR SHARE) чи видалення акаунта можуть пройти паралельно. Присутність щойно
    // вибулого учасника нешкідлива — це лише історія сесії.
    const publicIds = input.attendance.map((a) => a.publicId);
    const members = publicIds.length
      ? await tx
          .select({ userId: gameMembers.userId, publicId: users.publicId })
          .from(gameMembers)
          .innerJoin(users, eq(users.id, gameMembers.userId))
          .where(
            and(
              eq(gameMembers.gameId, g.id),
              isNull(gameMembers.leftAt),
              inArray(users.publicId, publicIds),
            ),
          )
      : [];
    const byPublicId = new Map(members.map((m) => [m.publicId, m.userId]));
    if (byPublicId.size !== publicIds.length) {
      throw new AppError(400, 'VALIDATION', { reason: 'UNKNOWN_MEMBER' });
    }
    const rows = input.attendance.map((a) => ({
      sessionId,
      userId: byPublicId.get(a.publicId)!,
      present: a.present,
    }));
    if (rows.length) await tx.insert(sessionAttendance).values(rows);
    await tx
      .update(gameSessions)
      .set({
        status: 'done',
        summary: input.summary,
        doneAt: now,
        ...(input.sendSummary ? { summarySentAt: now } : {}),
      })
      .where(eq(gameSessions.id, sessionId));
    if (input.sendSummary) {
      sent = await notifySummary(deps, tx, g, { ...session, summary: input.summary });
    }
    // Проведена сесія одразу знімає «мертвість» і адмінське звільнення (до наступної сесії).
    await tx
      .update(games)
      .set({ deadAt: null, deadExemptUntilSession: false, ...keepUpdatedAt })
      .where(
        and(
          eq(games.id, g.id),
          or(isNotNull(games.deadAt), eq(games.deadExemptUntilSession, true)),
        ),
      );
    return rows;
  });
  await logEvent(deps.db, {
    type: 'session.done',
    userId,
    entityType: 'session',
    entityId: sessionId,
    payload: {
      gameId: g.id,
      present: attendance.filter((a) => a.present).map((a) => a.userId),
      absent: attendance.filter((a) => !a.present).map((a) => a.userId),
    },
  });
  // Нові сесії з матеріалізації створив сам майстер своєю дією — для нього не «нові».
  if ((await materializeSessions(deps, g.id, now)) > 0) {
    await markGameSessionsViewed(deps, userId, g.id);
  }
  await afterGmSessionChange(deps, userId, g.id, sessionId);
  emitNotificationsNew(deps, sent);
  return reload(deps, userId, sessionId);
}

// ---------- підсумок проведеної сесії ----------

/**
 * Блокування гра (FOR SHARE) → сесія (FOR UPDATE), як у `lockScheduled`, але сесія має бути
 * проведеною (`done`); стан гри не важливий — підсумок можна дописати й після її завершення.
 */
async function lockDone(tx: Tx, gameId: number, sessionId: number): Promise<SessionRow> {
  const [game] = await tx
    .select({ id: games.id })
    .from(games)
    .where(eq(games.id, gameId))
    .for('share');
  if (!game) throw new AppError(404, 'NOT_FOUND');
  const [session] = await tx
    .select()
    .from(gameSessions)
    .where(eq(gameSessions.id, sessionId))
    .for('update');
  if (!session) throw new AppError(404, 'NOT_FOUND');
  if (session.status !== 'done') throw new AppError(409, 'SESSION_INVALID_STATE');
  return session;
}

/**
 * Сповіщення `session.summary` (категорія «Розклад», сайт + Telegram) усім, хто був активним
 * учасником гри на час сесії (вступив не пізніше початку й не вийшов до нього), крім майстра;
 * лише активним акаунтам, без забанених у цій грі й тих, хто вимкнув «Розклад» на сайті.
 * Викликати в транзакції, що тримає сесію FOR UPDATE і ставить `summary_sent_at`;
 * `emitNotificationsNew` — після коміту.
 */
async function notifySummary(
  deps: AppDeps,
  tx: Tx,
  game: Pick<GameRow, 'id' | 'title' | 'gmUserId'>,
  session: Pick<SessionRow, 'id' | 'startsAt' | 'summary'>,
): Promise<NotificationRow[]> {
  const members = await tx
    .select({ userId: gameMembers.userId })
    .from(gameMembers)
    .innerJoin(users, eq(users.id, gameMembers.userId))
    .where(
      and(
        eq(gameMembers.gameId, game.id),
        lte(gameMembers.joinedAt, session.startsAt),
        or(isNull(gameMembers.leftAt), gt(gameMembers.leftAt, session.startsAt)),
        ne(gameMembers.userId, game.gmUserId),
        eq(users.status, 'active'),
        notExists(
          tx
            .select({ id: gameBans.userId })
            .from(gameBans)
            .where(and(eq(gameBans.gameId, game.id), eq(gameBans.userId, gameMembers.userId))),
        ),
      ),
    );
  const params = {
    gameId: game.id,
    gameTitle: game.title,
    sessionId: session.id,
    startsAt: session.startsAt.toISOString(),
    excerpt: summaryExcerpt(session.summary ?? ''),
  };
  const planned = [...new Set(members.map((m) => m.userId))].map((userId) => ({
    userId,
    type: 'session.summary' as const,
    category: 'schedule' as const,
    params,
    entityType: 'session',
    entityId: session.id,
  }));
  const kept = await dropSiteMuted(tx, planned);
  const rows: NotificationRow[] = [];
  for (const n of kept) rows.push(await createNotification(deps, tx, n));
  return rows;
}

/**
 * Майстер задає чи змінює підсумок проведеної сесії (порожній — прибрати). Уже надісланий
 * підсумок після редагування повторно не розсилається.
 */
export async function setSessionSummary(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  body: unknown,
): Promise<SessionDto> {
  const input = sessionSummaryInputSchema.parse(body);
  const g = await loadForGm(deps, userId, sessionId);
  await deps.db.transaction(async (tx) => {
    await lockDone(tx, g.id, sessionId);
    await tx
      .update(gameSessions)
      .set({ summary: input.summary })
      .where(eq(gameSessions.id, sessionId));
  });
  await afterGmSessionChange(deps, userId, g.id, sessionId);
  return reload(deps, userId, sessionId);
}

/**
 * «Надіслати учасникам»: один раз на сесію (`summary_sent_at`; повторно → 409
 * `SUMMARY_ALREADY_SENT`), порожній підсумок → 422 `SUMMARY_EMPTY`.
 */
export async function sendSessionSummary(
  deps: AppDeps,
  userId: number,
  sessionId: number,
): Promise<SessionDto> {
  const g = await loadForGm(deps, userId, sessionId);
  const sent = await deps.db.transaction(async (tx) => {
    const session = await lockDone(tx, g.id, sessionId);
    if (session.summarySentAt) throw new AppError(409, 'SUMMARY_ALREADY_SENT');
    if (!session.summary?.trim()) throw new AppError(422, 'SUMMARY_EMPTY');
    await tx
      .update(gameSessions)
      .set({ summarySentAt: new Date() })
      .where(eq(gameSessions.id, sessionId));
    return notifySummary(deps, tx, g, session);
  });
  await afterGmSessionChange(deps, userId, g.id, sessionId);
  emitNotificationsNew(deps, sent);
  return reload(deps, userId, sessionId);
}
