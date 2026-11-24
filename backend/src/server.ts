import { existsSync } from 'node:fs';
import { loadEnv } from './config/env.js';
import { createServer } from 'node:http';
import { attachRealtime } from './realtime/socket.js';
import { createApp, type AppDeps } from './app.js';
import { createDb } from './db/client.js';
import { createRedis } from './redis/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const deps: AppDeps = { env, db, redis };
const httpServer = createServer();
deps.realtime = attachRealtime(httpServer, deps);
httpServer.on('request', createApp(deps));

httpServer.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`);
});
