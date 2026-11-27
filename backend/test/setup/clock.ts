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
  const fail = (why: string): never => {
    throw new Error(`test clock: ${why} — змінився @sinonjs/fake-timers у vitest?`);
  };
  const clock =
    (Date as unknown as { clock?: { now: number } }).clock ?? fail('підмінений Date без clock');
  const desc = Object.getOwnPropertyDescriptor(clock, 'now');
  if (!desc || !('value' in desc) || typeof desc.value !== 'number' || !desc.writable) {
    fail('clock.now — не звичайна числова властивість');
  }
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
  // Перевіряємо, що підмінений Date справді читає наш геттер.
  const probe = base + 86_400_000;
  clock.now = probe;
  if (Math.abs(Date.now() - probe) > 1000) fail('Date.now() не йде за clock.now');
  clock.now = probe - 86_400_000;
}

useTestClock();
beforeEach(useTestClock);
afterEach(useTestClock);
