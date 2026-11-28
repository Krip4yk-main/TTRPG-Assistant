/**
 * Простий семафор у межах процесу: не більше `limit` власників слота одночасно, решта чекає
 * в черзі FIFO (за бажанням — з тайм-аутом). Користувачі: імпорт iCal (`importSlots`),
 * перевірка посилань на картинки (`image-url.ts`).
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Чекає на слот щонайбільше `waitMs` (за замовчуванням — без обмеження). Повертає функцію
   * звільнення (повторний виклик — no-op) або `null`, якщо слот не звільнився вчасно.
   */
  acquire(waitMs = Infinity): Promise<(() => void) | null> {
    const grant = () => {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active--;
        this.waiters.shift()?.();
      };
    };
    if (this.active < this.limit) return Promise.resolve(grant());
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = () => {
        if (timer) clearTimeout(timer);
        resolve(grant());
      };
      this.waiters.push(waiter);
      if (Number.isFinite(waitMs)) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, waitMs);
      }
    });
  }
}
