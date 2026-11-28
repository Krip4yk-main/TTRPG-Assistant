import { describe, expect, it } from 'vitest';
import { publicConfigSchema } from './public-config.js';

describe('publicConfigSchema', () => {
  it('accepts a full config and a disabled one', () => {
    const on = {
      telegramBotUsername: 'nri_bot',
      providers: { telegram: true, google: true, discord: false },
    };
    expect(publicConfigSchema.parse(on)).toEqual(on);
    const off = {
      telegramBotUsername: null,
      providers: { telegram: false, google: false, discord: false },
    };
    expect(publicConfigSchema.parse(off)).toEqual(off);
  });

  it('rejects an empty bot name and missing providers', () => {
    expect(
      publicConfigSchema.safeParse({
        telegramBotUsername: '',
        providers: { telegram: false, google: false, discord: false },
      }).success,
    ).toBe(false);
    expect(publicConfigSchema.safeParse({ telegramBotUsername: null }).success).toBe(false);
  });
});
