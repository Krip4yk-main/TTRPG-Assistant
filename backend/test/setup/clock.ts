import { afterEach, beforeEach, vi } from 'vitest';
import { TEST_NOW } from '../test-now.js';

/**
 * Глобальний тестовий годинник (vitest `setupFiles`): підмінюємо лише `Date` (таймери
 * справжні), годинник стартує з `TEST_NOW` і безперервно йде вперед у реальному темпі. Перед і
 * після кожного тесту відновлюємо його — тож тест, що сам керував часом
 * (`vi.useFakeTimers`/`setSystemTime`/`useRealTimers`), не лишає реального чи чужого часу
 * наступним.
 */
// Модуль виконується заново для кожного тест-файлу (vitest `isolate`): відлік — від його початку.
const realStart = vi.getRealSystemTime();
const real = () => vi.getRealSystemTime();

function useTestClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'Temporal'], now: TEST_NOW + (real() - realStart) });
  // Підмінений `Date` читає `clock.now` (@sinonjs/fake-timers). Робимо його безперервним:
  // `shouldAdvanceTime` додає час кроками по 20 мс лише між макрозадачами, тож синхронний код
  // (бюджети часу, заміри тривалості) бачив би застиглий годинник. Присвоєння (`setSystemTime`,
  // `advanceTimersByTime`) переносять точку відліку.
  const clock = (Date as unknown as { clock?: { now: number } }).clock;
  if (!clock) throw new Error('test clock: fake Date без clock — змінився @sinonjs/fake-timers?');
  let base = clock.now;
  let baseReal = real();
  Object.defineProperty(clock, 'now', {
    configurable: true,
    enumerable: true,
    get: () => base + (real() - baseReal),
    set: (v: number) => {
      base = v;
      baseReal = real();
    },
  });
}

useTestClock();
beforeEach(useTestClock);
afterEach(useTestClock);
