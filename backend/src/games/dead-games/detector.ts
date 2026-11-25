import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { NotificationType } from '@nri/shared';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../applications/applications.rules.js';
import { isDuplicateKey, isTransientDbError } from '../../db/errors.js';
import { gameStalenessLog, games, users } from '../../db/schema/index.js';
import {
  createNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../../notifications/notifications.service.js';
import {
  CHECKED_STATUSES,
  checkedSessionAnchors,
  keepUpdatedAt,
  overlapRule,
  sessionAnchors,
  staleAnchor,
  staleInputOf,
  staleRule,
  type StaleInput,
} from './rules.js';

export const DEAD_GAMES_JOB = 'games.dead_detector';
export const DEAD_GAMES_AT_UTC = '04:00';

type Deps = Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>;
type StalenessKind = (typeof gameStalenessLog.$inferInsert)['kind'];

const NOTIFY: Record<StalenessKind, NotificationType> = {
  stale_reminder: 'game.stale_reminder',
  dead: 'game.dead',
  suspicious: 'game.suspicious',
};

/** Ключ запису журналу `game_staleness_log` (гра+вид+період). */
const logKey = (gameId: number, kind: StalenessKind, periodKey: string) =>
  `${gameId}|${kind}|${periodKey}`;

/**
 * Сповіщення майстру з дедупом журналом `game_staleness_log` (UNIQUE гра+вид+період) — у
 * транзакції викликача. Уже записане (попередній прогін, `logged`) не вставляємо зовсім;
 * паралельний прогін того самого періоду ловить UNIQUE → `null`.
 */
async function notifyOnce(
  deps: Deps,
  tx: Tx,
  logged: Set<string>,
  g: { id: number; title: string; gmUserId: number; gmActive: boolean },
  kind: StalenessKind,
  periodKey: string,
): Promise<NotificationRow | null> {
  if (logged.has(logKey(g.id, kind, periodKey))) return null;
  try {
    await tx.insert(gameStalenessLog).values({ gameId: g.id, kind, periodKey });
  } catch (err) {
    if (isDuplicateKey(err)) return null;
    throw err;
  }
  if (!g.gmActive) return null;
  return createNotification(deps, tx, {
    userId: g.gmUserId,
    type: NOTIFY[kind],
    category: 'games',
    params: { gameId: g.id, gameTitle: g.title },
    entityType: 'game',
    entityId: g.id,
  });
}

/** Період дедупу нагадування/позначки: відлік + кінець «все ок». */
const periodOf = (input: StaleInput, snoozedUntil: Date | null): string =>
  `${staleAnchor(input)?.toISOString() ?? '-'}|${snoozedUntil?.toISOString() ?? '-'}`;

export interface DetectorResult {
  reminded: number[];
  markedDead: number[];
  unmarkedDead: number[];
  markedSuspicious: number[];
  unmarkedSuspicious: number[];
}

/**
 * Щоденний детектор «мертвих» ігор (04:00 UTC; `now` — слот задачі). Для кожної гри в статусі
 * `recruiting`/`started`:
 * - `staleRule`: `remind` — сповіщення `game.stale_reminder`; `dead` — `dead_at` і
 *   `game.dead`; інакше знята позначка `dead_at` (з'явилась проведена сесія, «все ок», зняття
 *   адміном). Період дедупу — відлік + кінець «все ок»: після «все ок» нагадування й позначка
 *   повторюються, якщо проведених сесій так і немає;
 * - `overlapRule` (по майстру): `suspicious_at` і `game.suspicious` (період — дата позначки);
 *   менше 3 перетинів — позначка знімається; знята адміном — не повертається до
 *   `suspicious_dismissed_until`.
 * Гра без змін і без належного нагадування транзакції не відкриває; інша — окрема транзакція
 * (позначка «мертвої» — з блокуванням рядка й перерахунком за свіжими даними); збій однієї не
 * зупиняє інші (тимчасова помилка БД
 * прокидається в кінці — задача повторить; усе ідемпотентно).
 */
export async function runDeadGamesDetector(deps: Deps, now: Date): Promise<DetectorResult> {
  const { db } = deps;
  const result: DetectorResult = {
    reminded: [],
    markedDead: [],
    unmarkedDead: [],
    markedSuspicious: [],
    unmarkedSuspicious: [],
  };
  const rows = await db
    .select({ row: games, gmStatus: users.status, gmBanned: users.isBanned })
    .from(games)
    .innerJoin(users, eq(users.id, games.gmUserId))
    .where(inArray(games.status, CHECKED_STATUSES));
  if (rows.length === 0) return result;
  const anchors = await checkedSessionAnchors(db, now);
  const logged = new Set(
    (
      await db
        .select({
          gameId: gameStalenessLog.gameId,
          kind: gameStalenessLog.kind,
          periodKey: gameStalenessLog.periodKey,
        })
        .from(gameStalenessLog)
        .innerJoin(games, eq(games.id, gameStalenessLog.gameId))
        .where(inArray(games.status, CHECKED_STATUSES))
    ).map((l) => logKey(l.gameId, l.kind, l.periodKey)),
  );

  // Накладання — по майстрах із щонайменше двома активними іграми.
  const byGm = new Map<number, number>();
  for (const { row } of rows) byGm.set(row.gmUserId, (byGm.get(row.gmUserId) ?? 0) + 1);
  const overlapping = new Set<number>();
  for (const [gmId, n] of byGm) {
    if (n < 2) continue;
    for (const id of await overlapRule(db, gmId, now)) overlapping.add(id);
  }

  let failure: unknown;
  const created: NotificationRow[] = [];
  for (const { row, gmStatus, gmBanned } of rows) {
    const g = {
      id: row.id,
      title: row.title,
      gmUserId: row.gmUserId,
      gmActive: gmStatus === 'active' && !gmBanned,
    };
    const input = staleInputOf(row, anchors.get(row.id));
    const verdict = staleRule(input, now);
    const period = periodOf(input, row.deadSnoozedUntil);
    const dismissed = row.suspiciousDismissedUntil !== null && now < row.suspiciousDismissedUntil;
    const suspicious = overlapping.has(row.id) && !dismissed;
    const markDead = verdict === 'dead' && row.deadAt === null;
    const unmarkDead = verdict !== 'dead' && row.deadAt !== null;
    const remind = verdict === 'remind' && !logged.has(logKey(row.id, 'stale_reminder', period));
    const markSuspicious = suspicious && row.suspiciousAt === null;
    const unmarkSuspicious = !suspicious && row.suspiciousAt !== null;
    // Нічого не змінюється і нагадувати нема чого — без транзакції.
    if (!markDead && !unmarkDead && !remind && !markSuspicious && !unmarkSuspicious) continue;
    // Умова за поточним станом (а не з першого читання) — паралельні дії майстра/адміна не губляться.
    const active = and(eq(games.id, row.id), inArray(games.status, CHECKED_STATUSES));
    try {
      const rowsCreated = await db.transaction(async (tx) => {
        const out: NotificationRow[] = [];
        const push = (n: NotificationRow | null) => {
          if (n) out.push(n);
        };
        if (markDead) {
          // Сесію могли відмітити проведеною (чи майстер натиснув «все ок») після першого
          // читання: блокуємо рядок гри й перераховуємо вердикт за свіжими даними. Відмітка
          // сесії оновлює той самий рядок гри, тож вона або вже видна тут, або чекає на нашу
          // транзакцію й одразу зніме позначку.
          const [fresh] = await tx.select().from(games).where(active).for('update');
          if (fresh && fresh.deadAt === null) {
            const freshInput = staleInputOf(
              fresh,
              (await sessionAnchors(tx, [row.id], now)).get(row.id),
            );
            if (staleRule(freshInput, now) === 'dead') {
              const [res] = await tx
                .update(games)
                .set({ deadAt: now, ...keepUpdatedAt })
                .where(
                  and(
                    active,
                    isNull(games.deadAt),
                    eq(games.deadExemptUntilSession, false),
                    or(isNull(games.deadSnoozedUntil), lte(games.deadSnoozedUntil, now)),
                  ),
                );
              if (res.affectedRows > 0) {
                result.markedDead.push(row.id);
                const deadPeriod = periodOf(freshInput, fresh.deadSnoozedUntil);
                push(await notifyOnce(deps, tx, logged, g, 'dead', deadPeriod));
              }
            }
          }
        } else if (unmarkDead) {
          const [res] = await tx
            .update(games)
            .set({ deadAt: null, ...keepUpdatedAt })
            .where(and(active, isNotNull(games.deadAt)));
          if (res.affectedRows > 0) result.unmarkedDead.push(row.id);
        }
        if (remind) {
          const n = await notifyOnce(deps, tx, logged, g, 'stale_reminder', period);
          if (n) result.reminded.push(row.id);
          push(n);
        }
        if (markSuspicious) {
          const [res] = await tx
            .update(games)
            .set({ suspiciousAt: now, ...keepUpdatedAt })
            .where(and(active, isNull(games.suspiciousAt)));
          if (res.affectedRows > 0) {
            result.markedSuspicious.push(row.id);
            const day = now.toISOString().slice(0, 10);
            push(await notifyOnce(deps, tx, logged, g, 'suspicious', day));
          }
        } else if (unmarkSuspicious) {
          const [res] = await tx
            .update(games)
            .set({ suspiciousAt: null, ...keepUpdatedAt })
            .where(and(active, isNotNull(games.suspiciousAt)));
          if (res.affectedRows > 0) result.unmarkedSuspicious.push(row.id);
        }
        return out;
      });
      created.push(...rowsCreated);
    } catch (err) {
      console.error(`dead games: game ${row.id} failed`, err);
      if (isTransientDbError(err)) failure ??= err;
    }
  }
  emitNotificationsNew(deps, created);
  if (failure) throw failure;
  return result;
}
