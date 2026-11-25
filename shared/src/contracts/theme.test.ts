import { describe, expect, it } from 'vitest';
import { availableThemes, resolveTheme } from './theme.js';

describe('themes', () => {
  it('resolveTheme: дефолт, недоступний і невідомий дизайн', () => {
    expect(resolveTheme(null, 'user')).toBe('quest-board');
    expect(resolveTheme('classic', 'user')).toBe('quest-board');
    expect(resolveTheme('classic', 'owner')).toBe('classic');
    expect(resolveTheme('bogus', 'owner')).toBe('quest-board');
  });

  it('availableThemes: classic лише для власника', () => {
    expect(availableThemes('admin')).toEqual(['quest-board']);
    expect(availableThemes('owner')).toEqual(['quest-board', 'classic']);
  });
});
