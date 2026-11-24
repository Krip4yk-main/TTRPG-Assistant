import { existsSync } from 'node:fs';
import { loadEnv } from './config/env.js';
import { createServer } from 'node:http';
import { attachRealtime } from './realtime/socket.js';
import { createApp, type AppDeps } from './app.js';
import { createDb } from './db/client.js';
import { createRedis } from './redis/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const deps: AppDeps = { env, db, redis };
const httpServer = createServer();
deps.realtime = attachRealtime(httpServer, deps);
httpServer.on('request', createApp(deps));

httpServer.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`);
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
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
