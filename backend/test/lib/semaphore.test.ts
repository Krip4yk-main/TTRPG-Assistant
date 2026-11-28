import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/lib/semaphore.js';

describe('Semaphore', () => {
  it('at most N at once, FIFO queue, wait timeout, idempotent release', async () => {
    const sem = new Semaphore(2);
    const a = (await sem.acquire())!;
    const b = (await sem.acquire())!;
    expect(sem.inUse).toBe(2);
    expect(await sem.acquire(50)).toBeNull();
    expect(sem.queued).toBe(0);
    const order: string[] = [];
    const c = sem.acquire().then((r) => (order.push('c'), r!));
    const d = sem.acquire().then((r) => (order.push('d'), r!));
    expect(sem.queued).toBe(2);
    a();
    a();
    const rc = await c;
    expect(sem.inUse).toBe(2);
    b();
    const rd = await d;
    expect(order).toEqual(['c', 'd']);
    rc();
    rd();
    expect(sem.inUse).toBe(0);
  });
});
