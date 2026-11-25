import { defineConfig } from 'vitest/config';
import { TEST_WORKERS } from './test/setup/workers.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['test/setup/env.ts'],
    // Файли паралельно: кожен воркер має власну БД/Redis-базу/канал Socket.IO (test/setup/workers.ts).
    maxWorkers: TEST_WORKERS,
  },
});
