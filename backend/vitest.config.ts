import { defineConfig } from 'vitest/config';
import { TEST_WORKERS } from './test/setup/workers.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    // clock.ts — константний «зараз» у всіх тестах (test/test-now.ts); БД синхронізує helpers.ts.
    setupFiles: ['test/setup/env.ts', 'test/setup/clock.ts'],
    // Файли паралельно: кожен воркер має власну БД/Redis-базу/канал Socket.IO (test/setup/workers.ts).
    maxWorkers: TEST_WORKERS,
    // Інтеграційні тести (HTTP + MySQL з fsync на кожен коміт). Окремо найдовші — ~1 с, але при
    // повному прогоні 4 воркерів на одному MySQL у Docker Desktop окремі тести сповільнюються в
    // 4–5 разів (виміряно до 4.4 с; очікувань блокувань майже немає — ~1 с сумарно за прогін).
    // 5 с за замовчуванням не лишали запасу; 15 с і далі ловлять справжні зависання.
    testTimeout: 15_000,
  },
});
