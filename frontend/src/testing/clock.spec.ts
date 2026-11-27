import type { GameBusyDto } from '@nri/shared';
import { gameBusyCells } from '../app/features/calendar/availability-editor/availability-grid';
import { TEST_NOW } from './test-now';

const HOUR = 3_600_000;
const busy = (start: number, end: number): GameBusyDto => ({
  gameId: 1,
  gameTitle: 'Гра',
  sessionId: 1,
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
});
/** Скільки клітинок сітки зайнято (`gameBusyCells` без `now` — бере «зараз» сам). */
const busyCount = (b: GameBusyDto[]) =>
  gameBusyCells(b, 'Europe/Kyiv').filter((c) => c.length > 0).length;

describe('тестовий годинник', () => {
  it('за замовчуванням «зараз» — TEST_NOW, і він іде вперед', async () => {
    const t = Date.now();
    expect(t - TEST_NOW).toBeGreaterThanOrEqual(0);
    expect(t - TEST_NOW).toBeLessThan(10 * 60_000);
    await new Promise((r) => setTimeout(r, 60));
    expect(Date.now()).toBeGreaterThan(t);
  });

  it('gameBusyCells без now відкидає минуле відносно TEST_NOW', () => {
    expect(busyCount([busy(TEST_NOW - 2 * HOUR, TEST_NOW - HOUR)])).toBe(0);
    expect(busyCount([busy(TEST_NOW + HOUR, TEST_NOW + 2 * HOUR)])).toBe(2);
  });
});

describe('реальний годинник', () => {
  it('gameBusyCells без now бере справжній Date.now()', () => {
    vi.useRealTimers();
    const before = Date.now();
    expect(Math.abs(before - vi.getRealSystemTime())).toBeLessThan(1000);
    // Без жорстких дат: година, що минула за реальним часом, — уже не зайнятість. Під TEST_NOW
    // (у минулому відносно реального часу) вона була б майбутньою й зайняла б 2 клітинки.
    expect(busyCount([busy(before - 2 * HOUR, before - HOUR)])).toBe(0);
    expect(busyCount([busy(before + HOUR, before + 2 * HOUR)])).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });
});
