import { signal, type Signal } from '@angular/core';

/** Скільки триває підсвітка змінених елементів після оновлення, мс. */
export const HIGHLIGHT_MS = 2_500;

/** Відбиток елемента без `seen`: позначка перегляду — не зміна даних. */
const fingerprint = (item: unknown): string =>
  JSON.stringify(item, (k, v: unknown) => (k === 'seen' ? undefined : v));

/**
 * Ключі елементів, що з'явились або змінились між двома версіями списку. Порівняння — за
 * «відбитком» (`JSON` за замовчуванням), тож змінене будь-яке показане поле теж рахується.
 */
export function changedKeys<T, K>(
  prev: readonly T[] | null,
  next: readonly T[],
  key: (item: T) => K,
  print: (item: T) => string = fingerprint,
): K[] {
  if (!prev) return [];
  const before = new Map(prev.map((item) => [key(item), print(item)]));
  return next.filter((item) => before.get(key(item)) !== print(item)).map(key);
}

/** Короткочасна підсвітка елементів (CSS-клас `nri-flash`; без анімації — з reduced motion). */
export class Highlighter<K> {
  private readonly state = signal<ReadonlySet<K>>(new Set());
  readonly keys: Signal<ReadonlySet<K>> = this.state.asReadonly();
  private timer: ReturnType<typeof setTimeout> | null = null;

  flash(keys: readonly K[]): void {
    if (!keys.length) return;
    if (this.timer) clearTimeout(this.timer);
    this.state.set(new Set(keys));
    this.timer = setTimeout(() => {
      this.state.set(new Set());
      this.timer = null;
    }, HIGHLIGHT_MS);
  }

  has(key: K): boolean {
    return this.state().has(key);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
