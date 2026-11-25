import { existsSync } from 'node:fs';
import { loadEnv } from './config/env.js';
import type { AppDeps } from './app.js';
import { createHttpServer } from './http-server.js';
import { createDb } from './db/client.js';
import { createRedis } from './redis/client.js';
import { registerJobs } from './jobs/index.js';
import { startWorker, type Worker } from './jobs/worker.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const deps: AppDeps = { env, db, redis };
const httpServer = createHttpServer(deps);

httpServer.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`);
});

// Фоновий воркер черги задач (у тестах не запускається — тести викликають runDueJobs).
// ensureRecurring воркер викликає сам у циклі: недоступна на старті БД не валить API.
let worker: Worker | undefined;
if (env.NODE_ENV !== 'test') {
  registerJobs();
  worker = startWorker(deps);
}

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await worker?.stop(); // чекає поточну задачу, поки БД/Redis/сокети ще доступні
    await deps.realtime?.close(); // закриває й HTTP-сервер
    if (httpServer.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    await redis.quit();
    await pool.end();
  } catch (err) {
    console.error('shutdown error', err);
    process.exitCode = 1;
  }
  process.exit();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
