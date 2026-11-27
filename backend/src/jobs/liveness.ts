import type { Redis } from '../redis/client.js';

/**
 * Ключ heartbeat воркера в Redis (спільний для API та окремого процесу воркера): процес живий.
 * Пишеться окремим таймером — лише діагностика, `/api/health` за ним не судить.
 */
export const WORKER_HEARTBEAT_KEY = 'nri:worker:heartbeat';
/**
 * Штамп просування циклу задач: на початку й наприкінці кожного прогону та перед кожною
 * задачею. Завислий цикл (процес живий, heartbeat свіжий) перестає його оновлювати.
 */
export const WORKER_PROGRESS_KEY = 'nri:worker:progress';
/** TTL ключів heartbeat / progress, секунди. */
export const WORKER_STAMP_TTL_S = 600;
/** Штамп progress, старший за це, — воркер `stale`. */
export const WORKER_STALE_MS = 5 * 60_000;

async function stamp(redis: Redis, key: string, now: Date): Promise<void> {
  try {
    await redis.set(key, String(now.getTime()), 'EX', WORKER_STAMP_TTL_S);
  } catch (err) {
    console.error(`worker stamp ${key} failed`, err instanceof Error ? err.message : err);
  }
}

/** Пише heartbeat воркера (epoch ms) з TTL. Помилку не кидає — лише лог. */
export const writeWorkerHeartbeat = (redis: Redis, now: Date = new Date()): Promise<void> =>
  stamp(redis, WORKER_HEARTBEAT_KEY, now);

/** Пише штамп просування циклу задач (epoch ms) з TTL. Помилку не кидає — лише лог. */
export const writeWorkerProgress = (redis: Redis, now: Date = new Date()): Promise<void> =>
  stamp(redis, WORKER_PROGRESS_KEY, now);

/** Чи свіжий штамп progress (`raw` — значення ключа). */
export function isProgressFresh(raw: string | null, now: number = Date.now()): boolean {
  const at = raw === null ? NaN : Number(raw);
  return Number.isFinite(at) && now - at < WORKER_STALE_MS;
}
