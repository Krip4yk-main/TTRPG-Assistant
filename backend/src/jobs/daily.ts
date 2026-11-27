import { and, eq, inArray, lt, notExists, sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { revokeTokenHashes } from '../auth/session.service.js';
import { isTransientDbError } from '../db/errors.js';
import {
  gameApplications,
  gameMembers,
  games,
  jobs,
  notifications,
  reminderLog,
  sessions,
  users,
} from '../db/schema/index.js';
import { purgeTelegramOutbox } from '../notifications/telegram-outbox.js';
import { purgeRsvpDeclineNotices } from '../scheduling/reschedule.service.js';
import { materializeSessions } from '../sessions/materialize.js';
import { sessionsChanged } from '../realtime/game-rooms.js';

export const DAILY_JOB = 'maintenance.daily';
export const DAILY_AT_UTC = '03:00';

const DAY_MS = 86_400_000;
export const PENDING_USER_TTL_DAYS = 7;
export const READ_NOTIFICATION_TTL_DAYS = 90;
export const REMINDER_LOG_TTL_DAYS = 30;
export const DONE_JOB_TTL_DAYS = 3;
const PURGE_BATCH = 1000;
const DONE_JOB_PURGE_BATCH = 5000;

/**
 * Зсуває 28-денне вікно сесій для всіх ігор, що набирають або йдуть (ідемпотентно —
 * `materializeSessions`). Збій однієї гри не зупиняє інші (лог);
 * тимчасова помилка БД прокидається в кінці (задача повторить), інша — лише логується.
 * Повертає кількість створених сесій.
 */
export async function materializeAll(
  deps: Pick<AppDeps, 'db' | 'realtime'>,
  now = new Date(),
): Promise<number> {
  const rows = await deps.db
    .select({ id: games.id })
    .from(games)
    .where(inArray(games.status, ['recruiting', 'started']));
  let created = 0;
  let failure: unknown;
  for (const { id } of rows) {
    try {
      const n = await materializeSessions(deps, id, now);
      if (n > 0) sessionsChanged(deps, id);
      created += n;
    } catch (err) {
      console.error(`daily: materialize game ${id} failed`, err);
      if (isTransientDbError(err)) failure ??= err;
    }
  }
  if (failure) throw failure;
  return created;
}

/**
 * Видаляє незавершені реєстрації (`pending`, не забанені), старші 7 днів, без заявок, ігор і
 * членств.
 * Видалення акаунта (`deleteAccount`) — надгробок для активних користувачів; у `pending`
 * немає публічних слідів, тож рядок видаляється повністю (FK — CASCADE: ідентичності,
 * сесії, профіль тощо). Умови повторюються в самому DELETE (гонка з завершенням
 * реєстрації). Сесії видалених відкликаються й у Redis. Повертає кількість видалених.
 */
export async function purgePendingUsers(
  deps: Pick<AppDeps, 'db' | 'redis'>,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_USER_TTL_DAYS * DAY_MS);
  const stale = and(
    eq(users.status, 'pending'),
    // Забанений pending-акаунт лишається: видалення стерло б бан, і людина зареєструвалась би знову.
    eq(users.isBanned, false),
    lt(users.createdAt, cutoff),
    notExists(
      deps.db
        .select({ x: sql`1` })
        .from(gameApplications)
        .where(eq(gameApplications.userId, users.id)),
    ),
    notExists(
      deps.db
        .select({ x: sql`1` })
        .from(games)
        .where(eq(games.gmUserId, users.id)),
    ),
    notExists(
      deps.db
        .select({ x: sql`1` })
        .from(gameMembers)
        .where(eq(gameMembers.userId, users.id)),
    ),
  );
  let total = 0;
  for (;;) {
    const ids = (
      await deps.db.select({ id: users.id }).from(users).where(stale).limit(PURGE_BATCH)
    ).map((r) => r.id);
    if (ids.length === 0) break;
    const hashes = (
      await deps.db
        .select({ tokenHash: sessions.tokenHash })
        .from(sessions)
        .where(inArray(sessions.userId, ids))
    ).map((r) => r.tokenHash);
    const [res] = await deps.db.delete(users).where(and(inArray(users.id, ids), stale));
    total += res.affectedRows;
    // Надгробки й для тих, кого не видалили (гонка) — сесія pending-акаунта лише
    // перелогіниться; зате кеш видаленого не переживе рядок у БД.
    if (hashes.length) await revokeTokenHashes(deps, hashes);
    if (ids.length < PURGE_BATCH) break;
    if (res.affectedRows === 0) break; // усі кандидати «ожили» — не крутимось
  }
  return total;
}

/** Пачками по 1000 (короткі блокування), доки є що видаляти. */
async function deleteInBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < PURGE_BATCH) return total;
  }
}

/** Прочитані сповіщення, старші 90 днів. Непрочитані не чіпаються. */
export async function purgeReadNotifications(
  deps: Pick<AppDeps, 'db'>,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - READ_NOTIFICATION_TTL_DAYS * DAY_MS);
  return deleteInBatches(async () => {
    const [res] = await deps.db
      .delete(notifications)
      .where(lt(notifications.readAt, cutoff))
      .limit(PURGE_BATCH);
    return res.affectedRows;
  });
}

/**
 * Журнал нагадувань, старший 30 днів. Безпечно: найдовший офсет — 48 год, тож такі записи
 * належать сесіям, що давно почались, і вікно нагадувань їх більше не вибере.
 */
export async function purgeReminderLog(
  deps: Pick<AppDeps, 'db'>,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - REMINDER_LOG_TTL_DAYS * DAY_MS);
  return deleteInBatches(async () => {
    const [res] = await deps.db
      .delete(reminderLog)
      .where(lt(reminderLog.sentAt, cutoff))
      .limit(PURGE_BATCH);
    return res.affectedRows;
  });
}

/**
 * Виконані джоби (`done`), старші 3 діб, пачками по 5000 (таблиця росте тисячами рядків на
 * добу). `failed`/`pending`/`running` не чіпаються — їх розбирає людина або черга.
 */
export async function purgeDoneJobs(deps: Pick<AppDeps, 'db'>, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DONE_JOB_TTL_DAYS * DAY_MS);
  let total = 0;
  for (;;) {
    const [res] = await deps.db
      .delete(jobs)
      .where(and(eq(jobs.status, 'done'), lt(jobs.updatedAt, cutoff)))
      .limit(DONE_JOB_PURGE_BATCH);
    total += res.affectedRows;
    if (res.affectedRows < DONE_JOB_PURGE_BATCH) return total;
  }
}

/**
 * Щоденне обслуговування (03:00 UTC). Кроки ізольовані: збій одного логується й не
 * скасовує інші. Якщо був тимчасовий збій БД — помилка в кінці (задача повторить; усі кроки
 * ідемпотентні); нетимчасові помилки лише логуються (повтор їх не виправить).
 */
export async function runDaily(deps: AppDeps, now = new Date()): Promise<void> {
  const steps: [string, () => Promise<number>][] = [
    ['materializeAll', () => materializeAll(deps, now)],
    ['purgePendingUsers', () => purgePendingUsers(deps, now)],
    ['purgeReadNotifications', () => purgeReadNotifications(deps, now)],
    ['purgeReminderLog', () => purgeReminderLog(deps, now)],
    ['purgeTelegramOutbox', () => purgeTelegramOutbox(deps, now)],
    ['purgeRsvpDeclineNotices', () => purgeRsvpDeclineNotices(deps, now)],
    ['purgeDoneJobs', () => purgeDoneJobs(deps, now)],
  ];
  let failure: unknown;
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`daily: ${name} failed`, err);
      if (isTransientDbError(err)) failure ??= err;
    }
  }
  if (failure) throw failure;
}
