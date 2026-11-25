import { PAPERS, paperVariant } from './paper';

describe('paperVariant', () => {
  it('стабільний, у межах набору, у сусідніх id — різний', () => {
    for (let id = 0; id < 60; id++) {
      const v = paperVariant(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(PAPERS);
      expect(paperVariant(id)).toBe(v);
      expect(paperVariant(id + 1)).not.toBe(v);
    }
    expect(paperVariant(-7)).toBe(paperVariant(7));
  });

  it('кожен обрис трапляється з кожним нахилом (id % 6)', () => {
    const pairs = new Set<string>();
    for (let id = 0; id < 36; id++) pairs.add(`${id % 6}:${paperVariant(id)}`);
    expect(pairs.size).toBe(36);
  });
});
