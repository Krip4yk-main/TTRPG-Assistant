import { TEST_NOW } from './test-now';

/**
 * Глобальний тестовий годинник (`setupFiles` білдера `@angular/build:unit-test`, angular.json;
 * `vi`/хуки — глобали vitest): підмінюємо лише `Date` (таймери справжні), годинник стартує з
 * `TEST_NOW` і безперервно йде вперед у реальному темпі. Перед і після кожного тесту
 * відновлюємо його — тож тест, що сам керував часом (`vi.useFakeTimers`/`setSystemTime`/
 * `useRealTimers`), не лишає реального чи чужого часу наступним.
 */
let realStart = vi.getRealSystemTime();
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
// Білдер запускає файли без ізоляції (`isolate: false`), тож відлік явно починаємо з кожного
// тест-файлу заново: кожен файл стартує з TEST_NOW.
beforeAll(() => {
  realStart = real();
  useTestClock();
});
beforeEach(useTestClock);
afterEach(useTestClock);
