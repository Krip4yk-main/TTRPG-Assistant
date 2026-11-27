import { and, asc, eq, gt } from 'drizzle-orm';
import {
  evaluateGrid,
  START_WINDOW_MAX,
  START_WINDOW_STEP,
  toZoned,
  windowEnd,
  type GridPoint,
  type OneOffCandidateDto,
  type SessionWindowSlotsDto,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import { games, gameSessions } from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';
import { schedulingPeople } from '../scheduling/common-times.service.js';

const MIN = 60_000;

/**
 * Найближча `scheduled` сесія гри, чиє вікно початку ще не минуло (`starts_at` + вікно > now):
 * якщо вона з приблизним часом — 409 `SESSION_TIME_APPROXIMATE` з `details: { sessionId }`.
 * Старт гри (`recruiting → started`) спершу вимагає уточнити час (викликати в транзакції
 * переходу, після матеріалізації).
 */
export async function assertNearestSessionPinned(tx: Tx, gameId: number, now: Date): Promise<void> {
  const rows = await tx
    .select({
      id: gameSessions.id,
      startsAt: gameSessions.startsAt,
      startWindowMinutes: gameSessions.startWindowMinutes,
    })
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.gameId, gameId),
        eq(gameSessions.status, 'scheduled'),
        // Найширше вікно — `START_WINDOW_MAX`: раніші сесії вже точно минули.
        gt(gameSessions.startsAt, new Date(now.getTime() - START_WINDOW_MAX * MIN)),
      ),
    )
    .orderBy(asc(gameSessions.startsAt), asc(gameSessions.id));
  const nearest = rows.find((r) => windowEnd(r.startsAt, r.startWindowMinutes) > now);
  if (nearest && nearest.startWindowMinutes !== null) {
    throw new AppError(409, 'SESSION_TIME_APPROXIMATE', { sessionId: nearest.id });
  }
}

/**
 * `GET /api/sessions/:id/window-slots` — лише майстер гри (невідома сесія чи прихована гра
 * для не-майстра — 404, чужа — 403 `FORBIDDEN`); сесія має бути `scheduled` (інакше 409
 * `SESSION_INVALID_STATE`). Старти — кожні 30 хв від початку вікна до його кінця включно,
 * у UTC-мілісекундах (перехід на літній час не зсуває кінця вікна), лише майбутні. Оцінка
 * кожного старту на всю тривалість сесії — той самий механізм, що й підбір спільного часу
 * (`evaluateGrid` по календарях, зайнятих датах, сесіях інших ігор та імпорту iCal).
 */
export async function getSessionWindowSlots(
  deps: AppDeps,
  userId: number,
  sessionId: number,
  now: Date = new Date(),
): Promise<SessionWindowSlotsDto> {
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

  const durMs = session.durationMinutes * MIN;
  const first = session.startsAt.getTime();
  const last = windowEnd(session.startsAt, session.startWindowMinutes).getTime();
  const points: GridPoint[] = [];
  for (let t = first; t <= last; t += START_WINDOW_STEP * MIN) {
    if (t <= now.getTime()) continue;
    const start = new Date(t);
    const local = toZoned(start, game.timezone);
    points.push({
      start,
      end: new Date(t + durMs),
      weekday: local.weekday,
      startMin: local.hour * 60 + local.minute,
    });
  }

  const { participants, people } = await schedulingPeople(
    deps,
    game,
    { from: new Date(first), to: new Date(last + durMs) },
    now,
  );
  const verdicts = evaluateGrid(points, people);
  const slots = points.map((p, i): OneOffCandidateDto => {
    const statuses = people.map((person, k) => ({
      userId: person.userId,
      status: verdicts[k]![i]!.status,
    }));
    return {
      startsAt: p.start.toISOString(),
      endsAt: p.end.toISOString(),
      can: statuses.filter((s) => s.status === 'can').length,
      cannot: statuses.filter((s) => s.status === 'cannot').length,
      unknown: statuses.filter((s) => s.status === 'unknown').length,
      statuses,
    };
  });
  return {
    sessionId: session.id,
    startsAt: session.startsAt.toISOString(),
    startWindowMinutes: session.startWindowMinutes,
    timezone: game.timezone,
    durationMinutes: session.durationMinutes,
    participants,
    noCalendars: people.every((p) => !p.hasCalendar),
    slots,
  };
}
