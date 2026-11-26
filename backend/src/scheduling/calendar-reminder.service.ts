import { and, asc, eq, inArray, isNull, lte, ne, notExists, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { CALENDAR_REMINDER_DELAY_MS } from '@nri/shared';
import type { AppDeps } from '../app.js';
import type { Tx } from '../applications/applications.rules.js';
import type { Db } from '../db/client.js';
import { isTransientDbError } from '../db/errors.js';
import {
  availabilitySlots,
  calendarReminders,
  gameMembers,
  games,
  users,
} from '../db/schema/index.js';
import {
  createOptionalNotification,
  emitNotificationsNew,
  type NotificationRow,
} from '../notifications/notifications.service.js';

export const CALENDAR_REMINDERS_JOB = 'schedule.calendar_reminders';
/** Щогодини: «через 24 год після вступу» — з точністю до години. */
export const CALENDAR_REMINDERS_EVERY_MS = 3_600_000;
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 10;

type DbLike = Db | Tx;

/**
 * **Точка розширення** «у користувача немає даних календаря» — умова для `userId` (колонки
 * зовнішнього запиту): немає тижневих слотів. Task 4 (імпорт iCal) додає сюди
 * `notExists(підключений календар)`, тож і вибірка кандидатів, і перевірка в момент
 * надсилання враховують імпорт автоматично. Зайняті дати календарем не вважаються (як і в
 * підборі: без слотів учасник для майстра «невідомо»).
 */
export function noCalendarData(db: DbLike, userId: AnyMySqlColumn): SQL[] {
  return [
    notExists(
      db
        .select({ x: sql`1` })
        .from(availabilitySlots)
        .where(eq(availabilitySlots.userId, userId)),
    ),
  ];
}

/**
 * Нагадування заповнити календар (`calendar.empty`, категорія `schedule` — вимикається на сайті
 * й у Telegram): активному користувачу, що щонайменше 24 год є активним учасником кампейну
 * (набирає, йде чи на паузі), але не має даних календаря (`noCalendarData`). Для наявних
 * учасників (вступили давно) — на першому ж запуску. Рівно один раз назавжди: рядок
 * `calendar_reminders` вставляється в транзакції зі сповіщенням (`INSERT IGNORE` по PK), тож
 * повтор, перезапуск чи паралельний прогін не дублюють; вимкнена категорія — позначка є, а
 * сповіщення немає (і не буде). Колишні учасники, забанені й неактивні акаунти, майстри своїх
 * ігор — не кандидати. Повертає id користувачів, яким створено сповіщення.
 */
export async function runCalendarReminders(
  deps: Pick<AppDeps, 'db' | 'env'> & Partial<Pick<AppDeps, 'realtime'>>,
  now: Date,
): Promise<number[]> {
  const { db } = deps;
  const cutoff = new Date(now.getTime() - CALENDAR_REMINDER_DELAY_MS);
  const sent: number[] = [];
  const created: NotificationRow[] = [];
  let failure: unknown;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const rows = await db
      .select({
        userId: gameMembers.userId,
        gameId: games.id,
        gameTitle: games.title,
      })
      .from(gameMembers)
      .innerJoin(games, eq(games.id, gameMembers.gameId))
      .innerJoin(users, eq(users.id, gameMembers.userId))
      .where(
        and(
          isNull(gameMembers.leftAt),
          lte(gameMembers.joinedAt, cutoff),
          eq(games.kind, 'campaign'),
          inArray(games.status, ['recruiting', 'started', 'paused']),
          ne(games.gmUserId, gameMembers.userId),
          eq(users.status, 'active'),
          eq(users.isBanned, false),
          notExists(
            db
              .select({ x: sql`1` })
              .from(calendarReminders)
              .where(eq(calendarReminders.userId, gameMembers.userId)),
          ),
          ...noCalendarData(db, gameMembers.userId),
        ),
      )
      .orderBy(asc(gameMembers.joinedAt), asc(gameMembers.id))
      .limit(BATCH);
    // Кампейн для тексту — той, у який вступили найраніше.
    const firstGame = new Map<number, { gameId: number; gameTitle: string }>();
    for (const r of rows) if (!firstGame.has(r.userId)) firstGame.set(r.userId, r);
    let progressed = 0;
    for (const [userId, g] of firstGame) {
      try {
        const n = await db.transaction(async (tx) => {
          // Даних календаря могло з'явитись між вибіркою й транзакцією.
          const [still] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), ...noCalendarData(tx, users.id)));
          if (!still) return undefined;
          const [ins] = await tx
            .insert(calendarReminders)
            .ignore()
            .values({ userId, gameId: g.gameId, sentAt: now });
          if (ins.affectedRows === 0) return undefined;
          return createOptionalNotification(deps, tx, {
            userId,
            type: 'calendar.empty',
            category: 'schedule',
            params: { gameId: g.gameId, gameTitle: g.gameTitle },
            entityType: 'game',
            entityId: g.gameId,
          });
        });
        if (n === undefined) continue;
        progressed++;
        if (n) {
          created.push(n);
          sent.push(userId);
        }
      } catch (err) {
        console.error(`calendar reminder: user ${userId} failed`, err);
        if (isTransientDbError(err)) failure ??= err;
      }
    }
    if (rows.length < BATCH || progressed === 0) break;
  }
  emitNotificationsNew(deps, created);
  if (failure) throw failure;
  return sent;
}
