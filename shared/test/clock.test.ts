import { describe, expect, it, vi } from 'vitest';
import { TEST_NOW } from './test-now.js';

describe('тестовий годинник', () => {
  it('за замовчуванням «зараз» — TEST_NOW, і він іде вперед', async () => {
    const t = Date.now();
    expect(t).toBeGreaterThanOrEqual(TEST_NOW);
    expect(t - TEST_NOW).toBeLessThan(60_000);
    expect(new Date().getTime()).toBeGreaterThanOrEqual(t);
    await new Promise((r) => setTimeout(r, 60));
    expect(Date.now()).toBeGreaterThan(t);
  });

  it('тест, що перемкнув на реальний час, не лишає його наступним', () => {
    vi.useRealTimers();
    expect(Math.abs(Date.now() - vi.getRealSystemTime())).toBeLessThan(1000);
  });

  it('…наступний тест знову бачить TEST_NOW', () => {
    expect(Date.now() - TEST_NOW).toBeLessThan(60_000);
  });
});
