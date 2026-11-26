import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_PREFS } from './theme.js';
import { updateUiPrefsSchema } from './theme-schema.js';

describe('updateUiPrefsSchema', () => {
  it('accepts boolean tearAnimation and/or sendAnimation', () => {
    expect(updateUiPrefsSchema.parse({ tearAnimation: false })).toEqual({ tearAnimation: false });
    expect(updateUiPrefsSchema.parse({ sendAnimation: false })).toEqual({ sendAnimation: false });
    expect(updateUiPrefsSchema.parse({ tearAnimation: true, sendAnimation: false })).toEqual({
      tearAnimation: true,
      sendAnimation: false,
    });
  });

  it('rejects unknown keys, empty body or non-boolean values', () => {
    expect(updateUiPrefsSchema.safeParse({}).success).toBe(false);
    expect(updateUiPrefsSchema.safeParse({ tearAnimation: 'no' }).success).toBe(false);
    expect(updateUiPrefsSchema.safeParse({ sendAnimation: 1 }).success).toBe(false);
    expect(updateUiPrefsSchema.safeParse({ tearAnimation: true, x: 1 }).success).toBe(false);
  });

  it('guests get the animations on', () => {
    expect(DEFAULT_UI_PREFS).toEqual({ tearAnimation: true, sendAnimation: true });
  });
});
