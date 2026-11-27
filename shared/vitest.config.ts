import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Константний «зараз» у всіх тестах (test/test-now.ts).
    setupFiles: ['test/clock.setup.ts'],
  },
});
