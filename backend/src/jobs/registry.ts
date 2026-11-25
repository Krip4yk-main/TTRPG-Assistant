import { and, eq, inArray } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema/index.js';
import { enqueue } from './queue.js';

export type JobRow = typeof jobs.$inferSelect;
export type JobHandler = (deps: AppDeps, payload: unknown, job: JobRow) => Promise<void>;
export type RecurringSchedule = { everyMs: number } | { dailyAtUtc: string };

const handlers = new Map<string, JobHandler>();
const recurring = new Map<string, RecurringSchedule>();

const DAY_MS = 86_400_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function registerHandler(type: string, fn: JobHandler): void {
  handlers.set(type, fn);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

/**
 * Періодична задача (обробник реєструється окремо через `registerHandler`). Самопереплановування:
 * після успіху чи остаточної невдачі воркер ставить наступний запуск з ключем `type@<ISO runAt>`.
 */
export function registerRecurring(type: string, schedule: RecurringSchedule): void {
  if ('everyMs' in schedule) {
    if (!Number.isInteger(schedule.everyMs) || schedule.everyMs <= 0) {
      throw new Error(`invalid everyMs for ${type}`);
    }
  } else if (!HHMM.test(schedule.dailyAtUtc)) {
    throw new Error(`invalid dailyAtUtc for ${type}`);
  }
  recurring.set(type, schedule);
}

export function getRecurring(type: string): RecurringSchedule | undefined {
  return recurring.get(type);
}

/** Лише для тестів: очищає обробники й розклади. */
export function resetRegistry(): void {
  handlers.clear();
  recurring.clear();
}

/**
 * Найближчий слот строго після `after`. `everyMs` вирівнюється за епохою, тож різні процеси
 * обчислюють той самий слот (і той самий `uniqueKey`); `dailyAtUtc` — найближче HH:MM UTC.
 */
export function nextRunAt(schedule: RecurringSchedule, after: Date): Date {
  const t = after.getTime();
  if ('everyMs' in schedule) {
    return new Date((Math.floor(t / schedule.everyMs) + 1) * schedule.everyMs);
  }
  const [, hh, mm] = HHMM.exec(schedule.dailyAtUtc)!;
  const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
  const today = dayStart + (Number(hh) * 60 + Number(mm)) * 60_000;
  return new Date(today > t ? today : today + DAY_MS);
}

export const recurringKey = (type: string, runAt: Date): string => `${type}@${runAt.toISOString()}`;

/** Ставить наступний запуск періодичної задачі після `after` (дубль ключа — no-op). */
export async function scheduleNextRun(
  deps: { db: Pick<Db, 'insert'> },
  type: string,
  after: Date,
): Promise<void> {
  const schedule = recurring.get(type);
  if (!schedule) return;
  const runAt = nextRunAt(schedule, after);
  await enqueue(deps, { type, runAt, uniqueKey: recurringKey(type, runAt) });
}

/**
 * Для кожної періодичної задачі без pending/running-запуску ставить наступний. Воркер викликає
 * її на старті й далі приблизно раз на хвилину — самовідновлення, якщо ланцюжок обірвався.
 */
export async function ensureRecurring(
  deps: Pick<AppDeps, 'db'>,
  now: Date = new Date(),
): Promise<void> {
  for (const type of recurring.keys()) {
    const [existing] = await deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, type), inArray(jobs.status, ['pending', 'running'])))
      .limit(1);
    if (!existing) await scheduleNextRun(deps, type, now);
  }
}
