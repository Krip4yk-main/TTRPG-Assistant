import { and, eq, exists, gt, inArray, lte, or } from 'drizzle-orm';
import { FINAL_RATING_WINDOW_DAYS, SESSION_RATING_WINDOW_DAYS } from '@nri/shared';
import type { AppDeps } from '../app.js';
import { isDuplicateKey, isTransientDbError } from '../db/errors.js';
import { games, gameSessions, ratingReminderLog } from '../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';
import { openRatingSets, type OpenRatingSet } from './ratings.eligibility.js';

export const RATING_DEADLINE_JOB = 'ratings.deadline';
export const RATING_DEADLINE_EVERY_MS = 3_600_000;
/** За скільки до закриття вікна нагадувати: 2 доби. */
export const RATING_DEADLINE_LEAD_MS = 48 * 3_600_000;

const DAY_MS = 86_400_000;

/**
 * Нагадування «вікно оцінювання закривається» для задачі, запланованої на `runAt`: кожному
 * оцінювачу, у чийому наборі (сесійний — 14 днів від завершення сесії; підсумковий/«вихідний»
 * — 30 днів від завершення чи скасування гри) вікно закривається в (runAt, runAt + 48 год] і ще
 * відкрите на `now`, а `open` цілі є, — одне `rating.deadline` на (користувач, гра, сесія|
 * підсумковий). Відмова чи оцінка всіх → без нагадування; «вихідна», поки гра йде
 * (`closesAt` = null), — без дедлайну, отже без нагадування.
 *
 * Дедуплікація — `rating_reminder_log` UNIQUE(user, game, slot_key, kind): повторний чи
 * паралельний прогін (і щогодинні перекриті вікна) не дублює. Кожен набір — окрема транзакція;
 * оцінка, поставлена в ці мілісекунди, дасть щонайбільше одне зайве нагадування (прийнято).
 * Тимчасова помилка БД прокидається (задача повторить), інша — логується, решта обробляються.
 */
export async function sendRatingDeadlines(
  deps: AppDeps,
  runAt: Date,
  now: Date = new Date(),
): Promise<NotificationRow[]> {
  const from = runAt.getTime();
  const to = from + RATING_DEADLINE_LEAD_MS;
  const shifted = (days: number) => ({
    from: new Date(from - days * DAY_MS),
    to: new Date(to - days * DAY_MS),
  });
  const s = shifted(SESSION_RATING_WINDOW_DAYS);
  const f = shifted(FINAL_RATING_WINDOW_DAYS);
  const sessionClosing = deps.db
    .select({ id: gameSessions.id })
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.gameId, games.id),
        eq(gameSessions.status, 'done'),
        gt(gameSessions.doneAt, s.from),
        lte(gameSessions.doneAt, s.to),
      ),
    );
  const candidates = await deps.db
    .select({ id: games.id, title: games.title })
    .from(games)
    .where(
      or(
        and(eq(games.kind, 'campaign'), exists(sessionClosing)),
        and(
          eq(games.status, 'finished'),
          gt(games.finishedAt, f.from),
          lte(games.finishedAt, f.to),
        ),
        and(
          eq(games.status, 'cancelled'),
          gt(games.cancelledAt, f.from),
          lte(games.cancelledAt, f.to),
        ),
      ),
    );
  if (candidates.length === 0) return [];
  const titleOf = new Map(candidates.map((g) => [g.id, g.title]));
  const due = (
    await openRatingSets(
      deps.db,
      candidates.map((g) => g.id),
      now,
    )
  )
    .filter((x) => x.closesAt !== null)
    .filter((x) => x.closesAt!.getTime() > from && x.closesAt!.getTime() <= to)
    // Сталий порядок вставок у журнал: паралельні прогони не блокують одне одного по колу.
    .sort((a, b) => a.raterId - b.raterId || a.gameId - b.gameId || slot(a) - slot(b));

  // Дата сесії — у тексті нагадування для сесійних наборів.
  const sessionIds = [...new Set(due.flatMap((x) => x.sessionId ?? []))];
  const startsOf = new Map(
    (sessionIds.length
      ? await deps.db
          .select({ id: gameSessions.id, startsAt: gameSessions.startsAt })
          .from(gameSessions)
          .where(inArray(gameSessions.id, sessionIds))
      : []
    ).map((r) => [r.id, r.startsAt]),
  );

  const created: NotificationRow[] = [];
  for (const set of due) {
    try {
      const startsAt = set.sessionId !== null ? startsOf.get(set.sessionId) : undefined;
      const row = await remindSet(deps, set, titleOf.get(set.gameId) ?? null, startsAt);
      if (row) {
        emitNotificationsNew(deps, [row]);
        created.push(row);
      }
    } catch (err) {
      if (isTransientDbError(err)) throw err;
      console.error(
        `rating deadlines: user ${set.raterId} game ${set.gameId} slot ${slot(set)} failed`,
        err,
      );
    }
  }
  return created;
}

const slot = (s: OpenRatingSet) => s.sessionId ?? 0;

async function remindSet(
  deps: AppDeps,
  set: OpenRatingSet,
  gameTitle: string | null,
  startsAt: Date | undefined,
): Promise<NotificationRow | null> {
  return deps.db.transaction(async (tx) => {
    try {
      await tx.insert(ratingReminderLog).values({
        userId: set.raterId,
        gameId: set.gameId,
        sessionId: set.sessionId,
        kind: 'deadline',
      });
    } catch (err) {
      // Уже нагадано (цей чи паралельний прогін).
      if (isDuplicateKey(err)) return null;
      throw err;
    }
    return createNotification(deps, tx, {
      userId: set.raterId,
      type: 'rating.deadline',
      category: 'ratings',
      params: {
        gameId: set.gameId,
        gameTitle,
        ...(set.sessionId !== null ? { sessionId: set.sessionId } : {}),
        ...(startsAt ? { startsAt: startsAt.toISOString() } : {}),
        closesAt: set.closesAt!.toISOString(),
      },
      entityType: set.sessionId !== null ? 'session' : 'game',
      entityId: set.sessionId ?? set.gameId,
    });
  });
}
