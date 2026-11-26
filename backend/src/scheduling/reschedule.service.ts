import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import {
  RSVP_DECLINE_COOLDOWN_MS,
  RSVP_DECLINE_GRACE_MS,
  RSVP_DECLINE_MAX_WAIT_MS,
  RSVP_DECLINE_URGENT_MS,
  SESSION_ALTERNATIVES_RADIUS_MS,
  SESSION_ALTERNATIVES_TOP,
  type NotificationActor,
  type SessionAlternativesDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { isTransientDbError } from '../db/errors.js';
import {
  gameMembers,
  games,
  gameSessions,
  rsvpDeclineNotices,
  sessionRsvp,
  users,
} from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import {
  createOptionalNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { computeCommonTimes } from './common-times.service.js';

const DAY = 86_400_000;

// ---------- альтернативи для перенесення ----------

/**
 * `GET /api/sessions/:id/alternatives` — лише майстер гри (невідома сесія чи прихована гра
 * для не-майстра — 404, чужа — 403 `FORBIDDEN`); сесія має бути `scheduled` (інакше 409
 * `SESSION_INVALID_STATE`). Той самий підбір (`computeCommonTimes`) у вікні ±3 доби від
 * початку сесії (`from` — не раніше «зараз», тож минулий час не пропонується), тривалість — самої сесії; до 3 разових варіантів
 * без поточного часу сесії й без перетину з іншими запланованими сесіями гри. Нічого не
 * змінює — перенесення робить майстер наявним `POST /api/sessions/:id/reschedule`.
 */
export async function getSessionAlternatives(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  now: Date = new Date(),
): Promise<SessionAlternativesDto> {
  const [r] = await deps.db
    .select({ session: gameSessions, game: games })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) throw new AppError(404, 'NOT_FOUND');
  if (r.game.gmUserId !== userId) {
    if (isHiddenFromNonGm(r.game)) throw new AppError(404, 'NOT_FOUND');
    throw new AppError(403, 'FORBIDDEN');
  }
  const { session, game } = r;
  if (session.status !== 'scheduled') throw new AppError(409, 'SESSION_INVALID_STATE');

  const durationMinutes = session.durationMinutes;
  const durMs = durationMinutes * 60_000;
  const start = session.startsAt.getTime();
  const window = {
    from: new Date(Math.max(now.getTime(), start - SESSION_ALTERNATIVES_RADIUS_MS)),
    to: new Date(start + SESSION_ALTERNATIVES_RADIUS_MS),
  };
  // Інші заплановані сесії гри біля вікна: альтернатива не має з ними перетинатись.
  const others = (
    await deps.db
      .select({ startsAt: gameSessions.startsAt, durationMinutes: gameSessions.durationMinutes })
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.gameId, game.id),
          eq(gameSessions.status, 'scheduled'),
          ne(gameSessions.id, session.id),
          lt(gameSessions.startsAt, new Date(window.to.getTime() + durMs)),
          // Найдовша сесія — до доби: раніші вже не дотягнуться до вікна.
          gt(gameSessions.startsAt, new Date(window.from.getTime() - DAY)),
        ),
      )
  ).map((o) => ({
    start: o.startsAt.getTime(),
    end: o.startsAt.getTime() + o.durationMinutes * 60_000,
  }));
  const excludeOneOff = (s: Date, e: Date): boolean =>
    s.getTime() === start || others.some((o) => s.getTime() < o.end && o.start < e.getTime());

  const dto = await computeCommonTimes(deps, { ...game, durationMinutes }, window, {
    top: SESSION_ALTERNATIVES_TOP,
    now,
    excludeOneOff,
  });
  return {
    sessionId: session.id,
    startsAt: session.startsAt.toISOString(),
    timezone: dto.timezone,
    durationMinutes,
    from: dto.from,
    to: dto.to,
    participants: dto.participants,
    noCalendars: dto.noCalendars,
    alternatives: dto.oneOff,
  };
}

// ---------- «не буду» → сповіщення майстру ----------

/**
 * Викликається з `setRsvp` у його транзакції: учасник щойно поставив «не буду» (раніше було
 * інше або нічого). Лише позначка часу — саме сповіщення надсилає джоб
 * `RSVP_DECLINED_JOB` із затримкою (див. `runRsvpDeclineNotices`).
 */
export async function recordRsvpDecline(
  tx: Tx,
  sessionId: number,
  userId: number,
  now: Date,
): Promise<void> {
  await tx
    .insert(rsvpDeclineNotices)
    .values({ sessionId, userId, declinedAt: now })
    .onDuplicateKeyUpdate({ set: { declinedAt: now } });
}

/** Перенесення сесії скидає RSVP, тож і стан сповіщень про неї (нові відповіді — наново). */
export async function clearRsvpDeclines(tx: Tx, sessionId: number): Promise<void> {
  await tx.delete(rsvpDeclineNotices).where(eq(rsvpDeclineNotices.sessionId, sessionId));
}

export const RSVP_DECLINED_JOB = 'schedule.rsvp_declined';
export const RSVP_DECLINED_EVERY_MS = 60_000;
const DECLINE_SCAN_LIMIT = 1000;

interface PendingDecline {
  sessionId: number;
  userId: number;
  declinedAt: Date;
  notifiedAt: Date | null;
}

/**
 * Хто з «не буду» на одну сесію йде в сповіщення зараз. Кандидати — RSVP досі `not_going`,
 * нове «не буду» після останнього сповіщення і минула пауза `COOLDOWN` після нього. Готові —
 * кандидати, чиє «не буду» старше `GRACE` (встигли б передумати). Сесію відкладаємо, поки
 * хтось із кандидатів ще в `GRACE` (зберемо їх в одне сповіщення), але не довше `MAX_WAIT`
 * від найранішого готового. Сесія скоро (`startsAt − now ≤ URGENT`, 2 год) — без затримки й без
 * очікування: готові всі кандидати одразу (пауза `COOLDOWN` лишається).
 */
export function dueDeclines(
  rows: readonly PendingDecline[],
  now: Date,
  sessionStartsAt: Date,
): PendingDecline[] {
  const t = now.getTime();
  const candidates = rows.filter(
    (r) =>
      (r.notifiedAt === null || r.notifiedAt < r.declinedAt) &&
      (r.notifiedAt === null || r.notifiedAt.getTime() <= t - RSVP_DECLINE_COOLDOWN_MS),
  );
  if (sessionStartsAt.getTime() - t <= RSVP_DECLINE_URGENT_MS) return candidates;
  const ready = candidates.filter((r) => r.declinedAt.getTime() <= t - RSVP_DECLINE_GRACE_MS);
  if (ready.length === 0) return [];
  if (ready.length === candidates.length) return ready;
  const oldest = Math.min(...ready.map((r) => r.declinedAt.getTime()));
  return oldest <= t - RSVP_DECLINE_MAX_WAIT_MS ? ready : [];
}

/** Рядки «не буду», де RSVP досі `not_going` і є нове «не буду» після сповіщення. */
const pendingWhere = and(
  eq(sessionRsvp.status, 'not_going'),
  or(isNull(rsvpDeclineNotices.notifiedAt), lt(rsvpDeclineNotices.notifiedAt, rsvpDeclineNotices.declinedAt)),
);

const pendingSelect = {
  sessionId: rsvpDeclineNotices.sessionId,
  userId: rsvpDeclineNotices.userId,
  declinedAt: rsvpDeclineNotices.declinedAt,
  notifiedAt: rsvpDeclineNotices.notifiedAt,
};

/**
 * Джоб розумного перенесення (щохвилини): для кожної сесії з готовими «не буду»
 * (`dueDeclines`) — одне сповіщення майстру `session.rsvp_declined` (категорія `schedule`,
 * вимикається на сайті й у Telegram) зі всіма готовими учасниками. У транзакції: рядки сесії
 * `FOR UPDATE`, повторна перевірка, умовне `notified_at = now` — повтор задачі, перезапуск чи
 * паралельний прогін не дублюють сповіщення. Не надсилається (але позначається), якщо сесія
 * вже не `scheduled` чи почалась, гра не набирає/не йде, учасник вийшов з гри або майстер
 * неактивний. Повертає id сесій, про які сповіщено.
 */
export async function runRsvpDeclineNotices(
  deps: Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>,
  now: Date,
): Promise<number[]> {
  const rows = await deps.db
    .select(pendingSelect)
    .from(rsvpDeclineNotices)
    .innerJoin(
      sessionRsvp,
      and(
        eq(sessionRsvp.sessionId, rsvpDeclineNotices.sessionId),
        eq(sessionRsvp.userId, rsvpDeclineNotices.userId),
      ),
    )
    .innerJoin(gameSessions, eq(gameSessions.id, rsvpDeclineNotices.sessionId))
    .where(
      and(
        pendingWhere,
        // Учасники в паузі після сповіщення ще не готові — не скануємо їх щохвилини.
        or(
          isNull(rsvpDeclineNotices.notifiedAt),
          lte(rsvpDeclineNotices.notifiedAt, new Date(now.getTime() - RSVP_DECLINE_COOLDOWN_MS)),
        ),
        // Минула затримка — або сесія скоро (тоді без затримки).
        or(
          lte(rsvpDeclineNotices.declinedAt, new Date(now.getTime() - RSVP_DECLINE_GRACE_MS)),
          lte(gameSessions.startsAt, new Date(now.getTime() + RSVP_DECLINE_URGENT_MS)),
        ),
        gt(gameSessions.startsAt, now),
      ),
    )
    .orderBy(asc(rsvpDeclineNotices.declinedAt))
    .limit(DECLINE_SCAN_LIMIT);
  const sessionIds = [...new Set(rows.map((r) => r.sessionId))];
  const notified: number[] = [];
  const created: NotificationRow[] = [];
  let failure: unknown;
  for (const sessionId of sessionIds) {
    try {
      const n = await deps.db.transaction((tx) => notifySession(deps, tx, sessionId, now));
      if (n === undefined) continue;
      if (n) {
        created.push(n);
        notified.push(sessionId);
      }
    } catch (err) {
      console.error(`rsvp declined: session ${sessionId} failed`, err);
      if (isTransientDbError(err)) failure ??= err;
    }
  }
  emitNotificationsNew(deps, created);
  if (failure) throw failure;
  return notified;
}

/** `undefined` — нічого не готово; `null` — позначено без сповіщення. */
async function notifySession(
  deps: Pick<AppDeps, 'env'>,
  tx: Tx,
  sessionId: number,
  now: Date,
): Promise<NotificationRow | null | undefined> {
  const [r] = await tx
    .select({ session: gameSessions, game: games, gmStatus: users.status, gmBanned: users.isBanned })
    .from(gameSessions)
    .innerJoin(games, eq(games.id, gameSessions.gameId))
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(eq(gameSessions.id, sessionId));
  if (!r) return undefined;
  const locked = await tx
    .select(pendingSelect)
    .from(rsvpDeclineNotices)
    .innerJoin(
      sessionRsvp,
      and(
        eq(sessionRsvp.sessionId, rsvpDeclineNotices.sessionId),
        eq(sessionRsvp.userId, rsvpDeclineNotices.userId),
      ),
    )
    .where(and(eq(rsvpDeclineNotices.sessionId, sessionId), pendingWhere))
    .for('update');
  const due = dueDeclines(locked, now, r.session.startsAt).sort(
    (a, b) => a.declinedAt.getTime() - b.declinedAt.getTime(),
  );
  if (due.length === 0) return undefined;
  const dueIds = due.map((d) => d.userId);
  await tx
    .update(rsvpDeclineNotices)
    .set({ notifiedAt: now })
    .where(
      and(eq(rsvpDeclineNotices.sessionId, sessionId), inArray(rsvpDeclineNotices.userId, dueIds)),
    );

  const { session, game } = r;
  if (session.status !== 'scheduled' || session.startsAt <= now) return null;
  if (game.status !== 'recruiting' && game.status !== 'started') return null;
  if (r.gmStatus !== 'active' || r.gmBanned) return null;
  // Лише активні учасники (колишні не рахуються), у порядку їхнього «не буду».
  const people = await tx
    .select({ id: users.id, publicId: users.publicId, nickname: users.nickname })
    .from(gameMembers)
    .innerJoin(users, eq(users.id, gameMembers.userId))
    .where(
      and(
        eq(gameMembers.gameId, game.id),
        isNull(gameMembers.leftAt),
        inArray(gameMembers.userId, dueIds),
      ),
    );
  const byId = new Map(people.map((p) => [p.id, p]));
  const absentees: NotificationActor[] = dueIds
    .filter((id) => byId.has(id) && id !== game.gmUserId)
    .map((id) => ({ publicId: byId.get(id)!.publicId, nickname: byId.get(id)!.nickname }));
  if (absentees.length === 0) return null;
  return createOptionalNotification(deps, tx, {
    userId: game.gmUserId,
    type: 'session.rsvp_declined',
    category: 'schedule',
    params: {
      gameId: game.id,
      gameTitle: game.title,
      sessionId,
      startsAt: session.startsAt.toISOString(),
      actor: absentees[0]!,
      absentees,
      count: absentees.length - 1,
    },
    entityType: 'session',
    entityId: sessionId,
  });
}

/**
 * Щоденне прибирання: стан «не буду» сесій, що вже почались (вікно сповіщень їх не вибере).
 * Видалені сесії прибирає FK (CASCADE).
 */
export async function purgeRsvpDeclineNotices(
  deps: Pick<AppDeps, 'db'>,
  now = new Date(),
): Promise<number> {
  const past = deps.db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(lte(gameSessions.startsAt, now));
  const [res] = await deps.db
    .delete(rsvpDeclineNotices)
    .where(inArray(rsvpDeclineNotices.sessionId, past));
  return res.affectedRows;
}
