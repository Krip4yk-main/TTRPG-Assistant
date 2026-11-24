import { describe, expect, it } from 'vitest';
import { APPEAL_MESSAGE_MAX, appealInputSchema } from './appeals.js';

describe('appealInputSchema', () => {
  it('requires a token and a non-empty message of at most 2000 characters', () => {
    expect(APPEAL_MESSAGE_MAX).toBe(2000);
    expect(appealInputSchema.safeParse({ appealToken: 't', message: 'Прошу' }).success).toBe(true);
    expect(appealInputSchema.safeParse({ appealToken: '', message: 'Прошу' }).success).toBe(false);
    expect(appealInputSchema.safeParse({ appealToken: 't', message: '  ' }).success).toBe(false);
    expect(
      appealInputSchema.safeParse({ appealToken: 't', message: 'a'.repeat(2001) }).success,
    ).toBe(false);
  });
});
