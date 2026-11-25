import { existsSync } from 'node:fs';
import { currentWorkerId, workerDbUrl, workerRedisDb } from './workers.js';

// Локальні значення з backend/.env (gitignored); у CI змінні приходять із середовища.
if (existsSync('.env')) process.loadEnvFile('.env');

// Кожен воркер працює з власною БД, Redis-базою й каналом Socket.IO (див. workers.ts).
const id = currentWorkerId();
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL_TEST = workerDbUrl(process.env.DATABASE_URL_TEST, id);
}
process.env.TEST_REDIS_DB = String(workerRedisDb(id));
process.env.REALTIME_ADAPTER_KEY = `socket.io-test-${id}`;
