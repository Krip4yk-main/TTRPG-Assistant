import { describe, expect, it } from 'vitest';
import { availableThemes, resolveTheme } from './theme.js';

const ALL = [
  'quest-board',
  'neon-signs',
  'holo-market',
  'night-city',
  'dungeon',
  'gothic-gloom',
  'magicpunk',
  'brass-steam',
  'solar-garden',
  'painted-city',
];

describe('themes', () => {
  it('resolveTheme: дефолт, відомий і невідомий дизайн', () => {
    expect(resolveTheme(null, 'user')).toBe('quest-board');
    expect(resolveTheme('night-city', 'user')).toBe('night-city');
    expect(resolveTheme('neon-signs', 'admin')).toBe('neon-signs');
    expect(resolveTheme('bogus', 'owner')).toBe('quest-board');
  });

  it('прибраний «classic» (збережений у БД) дає дизайн за замовчуванням', () => {
    expect(resolveTheme('classic', 'owner')).toBe('quest-board');
    expect(resolveTheme('classic', 'user')).toBe('quest-board');
  });

  it('availableThemes: усі дизайни доступні кожній ролі', () => {
    for (const role of ['user', 'admin', 'owner'] as const) {
      expect(availableThemes(role)).toEqual(ALL);
    }
  });
});
