import { emptySafetyList } from '@nri/shared';
import { hasTopics, toSafetyView } from './safety-view';

const warnings = [
  { id: 1, slug: 'violence' },
  { id: 2, slug: 'gore' },
];

describe('toSafetyView', () => {
  it('nothing filled — null (no block at all)', () => {
    expect(
      toSafetyView(
        { safetyTools: [], lines: emptySafetyList(), veils: emptySafetyList() },
        warnings,
      ),
    ).toBeNull();
  });

  it('maps catalog ids to slugs, skipping unknown ones', () => {
    const view = toSafetyView(
      {
        safetyTools: ['check_ins'],
        lines: { warningIds: [2, 99], custom: ['Павуки'] },
        veils: emptySafetyList(),
      },
      warnings,
    )!;
    expect(view).toEqual({
      tools: ['check_ins'],
      lines: { slugs: ['gore'], custom: ['Павуки'] },
      veils: { slugs: [], custom: [] },
    });
    expect(hasTopics(view.lines)).toBe(true);
    expect(hasTopics(view.veils)).toBe(false);
  });
});
