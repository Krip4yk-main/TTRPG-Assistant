import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import type { Redis } from '../redis/client.js';

/** Ключ heartbeat воркера в Redis (спільний для API та окремого процесу воркера). */
export const WORKER_HEARTBEAT_KEY = 'nri:worker:heartbeat';
/** TTL ключа heartbeat, секунди. */
export const WORKER_HEARTBEAT_TTL_S = 600;
/** Heartbeat старший за це вважається застарілим. */
export const WORKER_STALE_MS = 5 * 60_000;
/** Ліміт кожної перевірки. */
export const HEALTH_CHECK_TIMEOUT_MS = 1000;

/** Пише heartbeat воркера (epoch ms) з TTL. Помилку не кидає — лише лог. */
export async function writeWorkerHeartbeat(redis: Redis, now: Date = new Date()): Promise<void> {
  try {
    await redis.set(WORKER_HEARTBEAT_KEY, String(now.getTime()), 'EX', WORKER_HEARTBEAT_TTL_S);
  } catch (err) {
    console.error('worker heartbeat failed', err instanceof Error ? err.message : err);
  }
}

type Status = 'ok' | 'down' | 'stale';

/** Виконує перевірку з таймаутом; будь-яка помилка чи прострочення → fallback. */
async function guarded(
  name: string,
  check: () => Promise<Status>,
  fallback: Status,
): Promise<Status> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<Status>((resolve) => {
        timer = setTimeout(() => {
          console.error(`health: ${name} timed out`);
          resolve(fallback);
        }, HEALTH_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(`health: ${name} failed`, err instanceof Error ? err.message : 'error');
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export function healthRouter({ db, redis }: Pick<AppDeps, 'db' | 'redis'>): Router {
  const router = Router();

  // Процес живий; без звернень до БД/Redis (docker healthcheck).
  router.get('/api/health/live', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/api/health', async (_req, res) => {
    const [dbStatus, redisStatus, worker] = await Promise.all([
      guarded('db', async () => (await db.execute(sql`SELECT 1`), 'ok'), 'down'),
      guarded('redis', async () => ((await redis.ping()) === 'PONG' ? 'ok' : 'down'), 'down'),
      guarded(
        'worker',
        async () => {
          const raw = await redis.get(WORKER_HEARTBEAT_KEY);
          const at = raw === null ? NaN : Number(raw);
          return Number.isFinite(at) && Date.now() - at < WORKER_STALE_MS ? 'ok' : 'stale';
        },
        'down',
      ),
    ]);
    const ok = dbStatus === 'ok' && redisStatus === 'ok' && worker === 'ok';
    res.status(ok ? 200 : 503).json({ ok, db: dbStatus, redis: redisStatus, worker });
  });

  return router;
}
