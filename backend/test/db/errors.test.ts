import { describe, expect, it } from 'vitest';
import { isDuplicateKey, isTransientDbError } from '../../src/db/errors.js';

describe('isTransientDbError', () => {
  it('recognises transient errnos and connection codes, plain and wrapped in cause', () => {
    for (const errno of [1213, 1205, 1040, 1053, 1317]) {
      expect(isTransientDbError({ errno })).toBe(true);
      expect(isTransientDbError(new Error('query failed', { cause: { errno } }))).toBe(true);
    }
    for (const code of [
      'PROTOCOL_CONNECTION_LOST',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
    ]) {
      const e = Object.assign(new Error(code), { code });
      expect(isTransientDbError(e)).toBe(true);
      expect(
        isTransientDbError(new Error('outer', { cause: new Error('mid', { cause: e }) })),
      ).toBe(true);
    }
  });

  it('other errors are not transient', () => {
    const dup = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    expect(isDuplicateKey(dup)).toBe(true);
    expect(isTransientDbError(dup)).toBe(false);
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('ECONNRESET')).toBe(false);
  });
});
