import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { MySanctionDto } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { ModerationApi } from './moderation.api';

/**
 * Мої чинні санкції (банер у шапці й сторінка «Обмеження акаунта»). Тягнуться для активного
 * користувача; оновлюються на вимогу (нове сповіщення, перепідключення, апеляція). Вихід або
 * зміна користувача скидають стан; запізнілі відповіді ігноруються.
 */
@Injectable({ providedIn: 'root' })
export class MySanctionsStore {
  private readonly api = inject(ModerationApi);
  private readonly auth = inject(AuthStore);

  private readonly _items = signal<MySanctionDto[] | null>(null);
  private readonly _error = signal(false);
  private seq = 0;
  private inFlight: Promise<void> | null = null;

  /** `null` — ще не завантажено. */
  readonly items = this._items.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasActive = computed(() => (this._items()?.length ?? 0) > 0);

  private readonly userId = computed(() => (this.auth.isActive() ? this.auth.me()!.id : null));

  constructor() {
    let current: number | null | undefined;
    effect(() => {
      const id = this.userId();
      untracked(() => {
        if (id === current) return;
        const first = current === undefined;
        current = id;
        if (first && id !== null && this.inFlight) return;
        this.seq++;
        this.inFlight = null;
        this._items.set(null);
        this._error.set(false);
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

  /** Замінити одну санкцію (відповідь на апеляцію) без повторного запиту. */
  replace(item: MySanctionDto): void {
    this._items.update((items) => items?.map((s) => (s.id === item.id ? item : s)) ?? items);
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    try {
      const items = await firstValueFrom(this.api.mySanctions());
      if (seq !== this.seq) return;
      this._items.set(items);
      this._error.set(false);
    } catch {
      if (seq === this.seq) this._error.set(true);
    }
  }
}
