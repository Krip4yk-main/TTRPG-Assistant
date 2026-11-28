import { Router } from 'express';
import { sql } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { WORKER_PROGRESS_KEY, isProgressFresh } from '../jobs/liveness.js';

/** Ліміт кожної перевірки. */
export const HEALTH_CHECK_TIMEOUT_MS = 1000;
/**
 * Скільки живе готовий результат `/api/health` (і успішний, і невдалий): часті опитування
 * моніторингу не б'ють щоразу по БД і Redis, а збій видно не пізніше ніж за цей час.
 */
export const HEALTH_CACHE_TTL_MS = 2000;

type Status = 'ok' | 'down' | 'stale';
type Readiness = { ok: boolean; db: Status; redis: Status; worker: Status };

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

  async function probe(): Promise<Readiness> {
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
    return { ok, db: dbStatus, redis: redisStatus, worker };
  }

  // Single-flight: одночасні запити чекають ту саму перевірку; готовий результат — на TTL
  // від моменту завершення перевірки (`guarded` не відхиляється, тож проміс завжди успішний).
  let cached: { result: Readiness; until: number } | null = null;
  let inFlight: Promise<Readiness> | null = null;
  function readiness(): Promise<Readiness> {
    if (cached && Date.now() < cached.until) return Promise.resolve(cached.result);
    inFlight ??= probe()
      .then((result) => {
        cached = { result, until: Date.now() + HEALTH_CACHE_TTL_MS };
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  router.get('/api/health', async (_req, res) => {
    const result = await readiness();
    res.status(result.ok ? 200 : 503).json(result);
  });

  return router;
}
