import { THEME_IDS } from '@nri/shared';
import { THEMES, THEME_EFFECT_NAMES, type ThemeEffectName } from './theme.registry';

describe('THEMES: фірмові анімації', () => {
  it('моменти: надсилання заявки, відкриття гри, «вас прийнято»', () => {
    const names: ThemeEffectName[] = ['applicationSent', 'gameOpened', 'acceptedNotice'];
    expect(THEME_EFFECT_NAMES).toEqual(names);
  });

  it('ефекти дизайнів — лише для відомих моментів і всі під спільним sendAnimation', () => {
    for (const id of THEME_IDS) {
      for (const [name, def] of Object.entries(THEMES[id].effects ?? {})) {
        expect(THEME_EFFECT_NAMES).toContain(name);
        expect(def?.pref).toBe('sendAnimation');
      }
    }
  });

  it('перемикач sendAnimation — рівно в дизайнів з ефектами', () => {
    for (const id of THEME_IDS) {
      const hasEffects = Object.keys(THEMES[id].effects ?? {}).length > 0;
      expect(THEMES[id].options?.includes('sendAnimation') ?? false).toBe(hasEffects);
    }
  });

  it('«Магіпанк» — конверт на надсилання заявки (лінивий чанк)', async () => {
    const def = THEMES.magicpunk.effects?.applicationSent;
    expect(def?.pref).toBe('sendAnimation');
    await expect(def!.load()).resolves.toBeTypeOf('function');
  });

  it.each([
    ['neon-signs', 'lightNeonSign'],
    ['night-city', 'pulseAlongBus'],
    ['brass-steam', 'printTelegraphTape'],
  ] as const)('%s — лише «заявку подано»: %s (лінивий чанк)', async (id, effect) => {
    const effects = THEMES[id].effects ?? {};
    expect(Object.keys(effects)).toEqual(['applicationSent']);
    expect(effects.applicationSent?.pref).toBe('sendAnimation');
    expect(THEMES[id].options).toContain('sendAnimation');
    const loaded = await effects.applicationSent!.load();
    expect(loaded).toBeTypeOf('function');
    expect(loaded.name).toBe(effect);
  });
});
