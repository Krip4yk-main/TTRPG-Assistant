import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS } from './theme.js';
import { updateUiPrefsSchema } from './theme-schema.js';

describe('updateUiPrefsSchema', () => {
  it('accepts a boolean tearAnimation', () => {
    expect(updateUiPrefsSchema.parse({ tearAnimation: false })).toEqual({ tearAnimation: false });
  });

  it('rejects unknown keys, missing or non-boolean values', () => {
    expect(updateUiPrefsSchema.safeParse({}).success).toBe(false);
    expect(updateUiPrefsSchema.safeParse({ tearAnimation: 'no' }).success).toBe(false);
    expect(updateUiPrefsSchema.safeParse({ tearAnimation: true, x: 1 }).success).toBe(false);
  });

  it('guests get the animation on', () => {
    expect(DEFAULT_UI_PREFS).toEqual({ tearAnimation: true });
  });
});
