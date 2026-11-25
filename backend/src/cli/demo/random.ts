/**
 * Детермінований генератор (mulberry32) і помічники вибору. Той самий `seed` дає ту саму
 * структуру демо-даних (часові мітки рахуються від `now`).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Рівномірне [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Ціле в [min, max] включно. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Дробове в [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('pick from empty list');
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  /** Вибір за вагами: `[[значення, вага], …]`. */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r < 0) return v;
    }
    return pairs[pairs.length - 1]![0];
  }

  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** `n` різних елементів (або всі, якщо їх менше). */
  sample<T>(xs: readonly T[], n: number): T[] {
    return this.shuffle(xs).slice(0, Math.max(0, n));
  }

  /** Приблизно нормальний розподіл (сума трьох рівномірних). */
  normal(mean: number, sd: number): number {
    const u = this.next() + this.next() + this.next() - 1.5;
    return mean + u * 2 * sd;
  }
}

/** Число з рядка (для `--seed=слово`). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Пул без повторів: видає елементи у випадковому порядку; коли закінчились — перемішує знову
 * (повтор можливий лише після вичерпання всього пулу).
 */
export class Deck<T> {
  private queue: T[] = [];

  constructor(
    private readonly rng: Rng,
    private readonly items: readonly T[],
  ) {}

  draw(): T {
    if (this.queue.length === 0) this.queue = this.rng.shuffle(this.items);
    return this.queue.pop()!;
  }
}
