import { describe, expect, it, vi } from 'vitest';
import type { TelegramOutboxItem } from '@nri/shared';
import { deliverOnce, type PollerDeps } from '../src/delivery/poller.js';
import { TEST_NOW } from './test-now.js';

const reminder = (id: number, startsAt: number): TelegramOutboxItem => ({
  id,
  chatId: String(1000 + id),
  kind: 'session.reminder',
  params: {
    gameId: 1,
    gameTitle: 'Гра',
    sessionId: 3,
    startsAt: new Date(startsAt).toISOString(),
    offsetMin: 60,
  },
  buttons: null,
  attempts: 0,
  timeZone: null,
  silent: false,
});

/** `deliverOnce` без `deps.now`: стале нагадування (сесія вже почалась) → `failed 'stale'`. */
async function staleIds(items: TelegramOutboxItem[]): Promise<number[]> {
  const markFailed = vi.fn(async () => undefined);
  const deps: PollerDeps = {
    client: { claimOutbox: async () => items, markSent: async () => undefined, markFailed },
    api: { sendMessage: async () => ({}) },
    render: () => ({ text: 'т', keyboard: undefined }),
    log: () => {},
  };
  await deliverOnce(deps);
  return markFailed.mock.calls.map((c) => (c as unknown as [number])[0]);
}

describe('тестовий годинник', () => {
  it('за замовчуванням «зараз» — TEST_NOW', async () => {
    expect(Date.now() - TEST_NOW).toBeGreaterThanOrEqual(0);
    expect(Date.now() - TEST_NOW).toBeLessThan(60_000);
    // Відносно TEST_NOW: хвилину тому — стале, за годину — ні.
    expect(
      await staleIds([reminder(1, TEST_NOW - 60_000), reminder(2, TEST_NOW + 3_600_000)]),
    ).toEqual([1]);
  });
});

describe('реальний годинник', () => {
  it('deliverOnce без deps.now бере справжній Date.now()', async () => {
    vi.useRealTimers();
    const real = Date.now();
    // Без жорстких дат: хвилину тому за реальним часом — стале. Під TEST_NOW (у минулому
    // відносно реального часу) нагадування №1 ще не було б сталим.
    expect(await staleIds([reminder(1, real - 60_000), reminder(2, real + 3_600_000)])).toEqual([
      1,
    ]);
    expect(Date.now()).toBeGreaterThanOrEqual(real);
    expect(Math.abs(Date.now() - vi.getRealSystemTime())).toBeLessThan(1000);
  });
});
