import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  commonTimesQuerySchema,
  commonTimesWindow,
  COMMON_TIMES_DEFAULT_WEEKS,
  findCommonTimes,
  type AvailabilityDto,
  type BusyInterval,
  type CommonTimesDto,
  type CommonTimesPerson,
  type Weekday,
} from '@nri/shared';
import type { AppDeps } from '../app.js';
import { gameBusyIntervalsForUsers } from '../calendar/game-busy.service.js';
import {
  availabilityBusyDates,
  availabilitySlots,
  gameMembers,
  games,
  users,
} from '../db/schema/index.js';
import { isHiddenFromNonGm } from '../games/games.visibility.js';
import { AppError } from '../http/errors.js';

type GameRow = typeof games.$inferSelect;

/** Учасник підбору: майстер або активний учасник гри з його календарем. */
export interface SchedulingParticipant {
  userId: number;
  nickname: string | null;
  isGm: boolean;
  /** Пояс акаунта: у ньому задано слоти й зайняті дати. */
  timezone: string;
  slots: AvailabilityDto['slots'];
  busyDates: string[];
}

/** Зовнішня зайнятість одного користувача (див. `collectBusy`). */
export interface ParticipantBusy {
  intervals: BusyInterval[];
  /**
   * Є імпортований календар (Task 4: iCal) — учасник без тижневих слотів тоді не «невідомо»:
   * вільний усюди, де немає подій.
   */
  imported: boolean;
}

/**
 * Майстер і активні учасники (`left_at IS NULL`) гри разом із тижневими слотами й зайнятими
 * датами — 3 запити незалежно від розміру групи. Майстер — першим, далі за часом вступу.
 */
export async function loadParticipants(
  deps: AppDeps,
  game: Pick<GameRow, 'id' | 'gmUserId'>,
): Promise<SchedulingParticipant[]> {
  const { db } = deps;
  const members = await db
    .select({ userId: gameMembers.userId })
    .from(gameMembers)
    .where(and(eq(gameMembers.gameId, game.id), isNull(gameMembers.leftAt)))
    .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id));
  const ids = [game.gmUserId, ...members.map((m) => m.userId).filter((u) => u !== game.gmUserId)];
  const [people, slots, busy] = await Promise.all([
    db
      .select({ id: users.id, nickname: users.nickname, timezone: users.timezone })
      .from(users)
      .where(inArray(users.id, ids)),
    db
      .select()
      .from(availabilitySlots)
      .where(inArray(availabilitySlots.userId, ids))
      .orderBy(asc(availabilitySlots.weekday), asc(availabilitySlots.startMin)),
    db.select().from(availabilityBusyDates).where(inArray(availabilityBusyDates.userId, ids)),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const u = byId.get(id)!;
      return {
        userId: id,
        nickname: u.nickname,
        isGm: id === game.gmUserId,
        timezone: u.timezone,
        slots: slots
          .filter((s) => s.userId === id)
          .map((s) => ({ weekday: s.weekday as Weekday, startMin: s.startMin, endMin: s.endMin })),
        busyDates: busy.filter((b) => b.userId === id).map((b) => b.date),
      };
    });
}

/**
 * **Точка розширення** зайнятості учасників у `[from, to)`: зараз — сесії інших ігор
 * (`gameBusyIntervalsForUsers`, з повагою до `calendar_autobusy` і закріплень), без сесій
 * самої гри `excludeGameId`. Task 4 (імпорт iCal) додає сюди імпортовані інтервали одним
 * пакетним запитом і ставить `imported: true` тим, у кого підключено календар.
 */
export async function collectBusy(
  deps: AppDeps,
  userIds: readonly number[],
  from: Date,
  to: Date,
  opts: { excludeGameId?: number; now?: Date } = {},
): Promise<Map<number, ParticipantBusy>> {
  const gameBusy = await gameBusyIntervalsForUsers(deps, userIds, from, to, opts.now);
  const out = new Map<number, ParticipantBusy>();
  for (const u of userIds) {
    const intervals = (gameBusy.get(u) ?? [])
      .filter((b) => b.gameId !== opts.excludeGameId)
      .map((b) => ({ start: b.start, end: b.end }));
    out.set(u, { intervals, imported: false });
  }
  return out;
}

/**
 * Підбір для гри у вікні `[from, to)` без перевірки прав — для повторного використання
 * (голосування заповнює варіанти, розумне перенесення шукає альтернативи на тижні сесії).
 * Разові ігри (oneshot) отримують лише разові кандидати.
 */
export async function computeCommonTimes(
  deps: AppDeps,
  game: GameRow,
  window: { from: Date; to: Date },
  opts: { top?: number; now?: Date } = {},
): Promise<CommonTimesDto> {
  const participants = await loadParticipants(deps, game);
  // Кандидат, що починається біля кінця вікна, триває ще `durationMinutes` — зайнятість
  // потрібна до `to + durationMinutes`.
  const busy = await collectBusy(
    deps,
    participants.map((p) => p.userId),
    window.from,
    new Date(window.to.getTime() + game.durationMinutes * 60_000),
    { excludeGameId: game.id, now: opts.now },
  );
  const people: CommonTimesPerson[] = participants.map((p) => {
    const b = busy.get(p.userId) ?? { intervals: [], imported: false };
    return {
      userId: p.userId,
      timezone: p.timezone,
      slots: p.slots,
      busyDates: p.busyDates,
      busy: b.intervals,
      hasCalendar: p.slots.length > 0 || b.imported,
    };
  });
  const found = findCommonTimes({
    timezone: game.timezone,
    durationMinutes: game.durationMinutes,
    from: window.from,
    to: window.to,
    people,
    regular: game.kind === 'campaign',
    top: opts.top,
  });
  return {
    timezone: game.timezone,
    durationMinutes: game.durationMinutes,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    participants: participants.map((p, i) => ({
      userId: p.userId,
      nickname: p.nickname,
      isGm: p.isGm,
      hasCalendar: people[i]!.hasCalendar,
    })),
    noCalendars: people.every((p) => !p.hasCalendar),
    ...found,
  };
}

/** Гра, якою керує `userId`: невідома/прихована → 404, чужа → 403 `FORBIDDEN`. */
export async function loadGmGame(deps: AppDeps, userId: number, gameId: number): Promise<GameRow> {
  const [g] = await deps.db.select().from(games).where(eq(games.id, gameId));
  if (!g) throw new AppError(404, 'NOT_FOUND');
  if (g.gmUserId !== userId) {
    if (isHiddenFromNonGm(g)) throw new AppError(404, 'NOT_FOUND');
    throw new AppError(403, 'FORBIDDEN');
  }
  return g;
}

/**
 * `GET /api/games/:id/common-times` — лише майстер гри. Будь-який статус гри (зокрема пауза:
 * майстер планує відновлення). `weeks` (1–8, за замовчуванням 4) від «зараз» або `weekOf` —
 * один тиждень пн–нд у поясі гри.
 */
export async function getCommonTimes(
  deps: AppDeps,
  userId: number,
  gameId: number,
  rawQuery: unknown,
  now: Date = new Date(),
): Promise<CommonTimesDto> {
  const game = await loadGmGame(deps, userId, gameId);
  const q = commonTimesQuerySchema.parse(rawQuery);
  const window = commonTimesWindow(game.timezone, now, {
    weeks: q.weeks ?? COMMON_TIMES_DEFAULT_WEEKS,
    weekOf: q.weekOf,
  });
  return computeCommonTimes(deps, game, window, { now });
}
