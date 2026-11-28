import { describe, expect, it } from 'vitest';
import { updateDefaultViewSchema } from './me.js';
import { DEFAULT_VIEW_MODE, VIEW_MODES, isViewMode } from './view-mode.js';

describe('updateDefaultViewSchema', () => {
  it('accepts player or gm', () => {
    expect(updateDefaultViewSchema.parse({ defaultView: 'gm' })).toEqual({ defaultView: 'gm' });
    expect(updateDefaultViewSchema.parse({ defaultView: 'player' })).toEqual({
      defaultView: 'player',
    });
  });

  it('rejects unknown values, empty body or extra keys', () => {
    expect(updateDefaultViewSchema.safeParse({}).success).toBe(false);
    expect(updateDefaultViewSchema.safeParse({ defaultView: 'admin' }).success).toBe(false);
    expect(updateDefaultViewSchema.safeParse({ defaultView: 1 }).success).toBe(false);
    expect(updateDefaultViewSchema.safeParse({ defaultView: 'gm', x: 1 }).success).toBe(false);
  });

  it('the default view is player; isViewMode guards the values', () => {
    expect(VIEW_MODES).toEqual(['player', 'gm']);
    expect(DEFAULT_VIEW_MODE).toBe('player');
    expect(isViewMode('gm')).toBe(true);
    expect(isViewMode('admin')).toBe(false);
    expect(isViewMode(null)).toBe(false);
  });
});
