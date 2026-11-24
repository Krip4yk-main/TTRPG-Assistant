import { existsSync } from 'node:fs';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { createDb } from './db/client.js';
import { createRedis } from './redis/client.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL);
const app = createApp({ env, db, redis });

app.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`);
});
