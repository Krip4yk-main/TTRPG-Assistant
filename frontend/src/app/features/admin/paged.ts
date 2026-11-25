import { type Signal, computed, signal } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import type { AdminPageDto } from '@nri/shared';

/** Стан списку для `nri-admin-pager` (без типу елементів). */
export interface PagedView {
  readonly items: Signal<readonly unknown[]>;
  readonly loading: Signal<boolean>;
  readonly loaded: Signal<boolean>;
  readonly error: Signal<boolean>;
  readonly hasMore: Signal<boolean>;
  reload(): Promise<void>;
  more(): Promise<void>;
}

/**
 * Список адмінки сторінками з курсором: `reload()` — перша сторінка (замінює список),
 * `more()` — наступна (дописує). Відповіді застарілих запитів (після нового `reload`)
 * ігноруються.
 */
export class Paged<T> implements PagedView {
  private readonly _items = signal<T[]>([]);
  private readonly _cursor = signal<number | null>(null);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _error = signal(false);
  private generation = 0;

  readonly items = this._items.asReadonly();
  readonly loading = this._loading.asReadonly();
  /** Перша сторінка вже прийшла (щоб відрізнити «порожньо» від «ще не знаємо»). */
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasMore = computed(() => this._cursor() !== null);

  /**
   * @param key ключ елемента (дедуплікація між сторінками, заміна після дії); типово — `id`.
   */
  constructor(
    private readonly fetch: (cursor: number | null) => Observable<AdminPageDto<T>>,
    private readonly key: (item: T) => string | number = (item) => (item as { id: number }).id,
  ) {}

  async reload(): Promise<void> {
    const gen = ++this.generation;
    this._items.set([]);
    this._cursor.set(null);
    this._loaded.set(false);
    await this.load(null, gen);
  }

  async more(): Promise<void> {
    const cursor = this._cursor();
    if (cursor === null || this._loading()) return;
    await this.load(cursor, this.generation);
  }

  /** Замінити елемент відповіддю сервера після дії. */
  replace(item: T): void {
    const k = this.key(item);
    this._items.update((items) => items.map((i) => (this.key(i) === k ? item : i)));
  }

  remove(item: T): void {
    const k = this.key(item);
    this._items.update((items) => items.filter((i) => this.key(i) !== k));
  }

  private async load(cursor: number | null, gen: number): Promise<void> {
    this._loading.set(true);
    this._error.set(false);
    try {
      const page = await firstValueFrom(this.fetch(cursor));
      if (gen !== this.generation) return;
      const known = new Set(this._items().map(this.key));
      this._items.update((items) => [
        ...items,
        ...page.items.filter((i) => !known.has(this.key(i))),
      ]);
      this._cursor.set(page.nextCursor);
      this._loaded.set(true);
    } catch {
      if (gen === this.generation) this._error.set(true);
    } finally {
      if (gen === this.generation) this._loading.set(false);
    }
  }
}
