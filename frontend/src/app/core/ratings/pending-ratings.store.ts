import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { RatingTargetsDto } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { RatingsApi } from './ratings.api';

/**
 * «Кого я можу оцінити» для шапки й сторінки «Оцінити». Список тягнеться для активного
 * користувача й оновлюється на вимогу (перехід між сторінками, нове сповіщення, надсилання
 * оцінки). Вихід або зміна користувача скидають стан; запізнілі відповіді ігноруються.
 */
@Injectable({ providedIn: 'root' })
export class PendingRatingsStore {
  private readonly api = inject(RatingsApi);
  private readonly auth = inject(AuthStore);

  private readonly _sets = signal<RatingTargetsDto[] | null>(null);
  private readonly _error = signal(false);
  private seq = 0;
  private inFlight: Promise<void> | null = null;
  /** Коли востаннє успішно отримано список (мс); для `refreshIfStale`. */
  private loadedAt = 0;

  /** `null` — ще не завантажено. */
  readonly sets = this._sets.asReadonly();
  readonly error = this._error.asReadonly();
  /** Кількість відкритих цілей у всіх наборах. */
  readonly openCount = computed(() =>
    (this._sets() ?? []).reduce(
      (sum, s) => sum + s.targets.filter((t) => t.state === 'open').length,
      0,
    ),
  );

  private readonly userId = computed(() => (this.auth.isActive() ? this.auth.me()!.id : null));

  constructor() {
    let current: number | null | undefined;
    effect(() => {
      const id = this.userId();
      untracked(() => {
        // Перший запуск ефекту може прийти вже після `refresh()` того самого користувача.
        if (id === current) return;
        const first = current === undefined;
        current = id;
        if (first && id !== null && this.inFlight) return;
        this.seq++;
        this.inFlight = null;
        this._sets.set(null);
        this._error.set(false);
        this.loadedAt = 0;
        if (id !== null) void this.refresh();
      });
    });
  }

  /** Перечитати список; паралельні виклики зливаються в один запит. */
  refresh(): Promise<void> {
    if (this.userId() === null) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const p: Promise<void> = this.load().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  /** Перечитати, лише якщо список старший за `maxAgeMs` (часті переходи між сторінками). */
  refreshIfStale(maxAgeMs: number): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.loadedAt && Date.now() - this.loadedAt < maxAgeMs) return Promise.resolve();
    return this.refresh();
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    try {
      const sets = await firstValueFrom(this.api.pending());
      if (seq !== this.seq) return;
      this._sets.set(sets);
      this._error.set(false);
      this.loadedAt = Date.now();
    } catch {
      if (seq === this.seq) this._error.set(true);
    }
  }
}
