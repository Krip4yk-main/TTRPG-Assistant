import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../src/db/schema/index.js';
import { logEvent } from '../../src/events/events.service.js';
import { closeDeps, resetDb, testDeps } from '../helpers.js';

const deps = await testDeps();
const { db } = deps;

beforeEach(() => resetDb(db));
afterAll(async () => {
  await closeDeps(deps);
});

describe('logEvent', () => {
  it('stores payload as a readable object', async () => {
    await logEvent(db, { type: 'x', payload: { a: 1 } });
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('x');
    expect(rows[0]!.payload).toEqual({ a: 1 });
  });

  it('never throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      insert: () => {
        throw new Error('boom');
      },
    } as never;
    await expect(logEvent(broken, { type: 'x' })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
