import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { WORKER_PROGRESS_KEY, isProgressFresh } from '../jobs/liveness.js';

/** Ліміт кожної перевірки. */
export const HEALTH_CHECK_TIMEOUT_MS = 1000;

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
        // Судимо за просуванням циклу задач, а не за heartbeat: завислий цикл → stale.
        async () => (isProgressFresh(await redis.get(WORKER_PROGRESS_KEY)) ? 'ok' : 'stale'),
        'down',
      ),
    ]);
    const ok = dbStatus === 'ok' && redisStatus === 'ok' && worker === 'ok';
    res.status(ok ? 200 : 503).json({ ok, db: dbStatus, redis: redisStatus, worker });
  });

  return router;
}
