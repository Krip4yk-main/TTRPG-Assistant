import {
  MAX_SHIFT_PX,
  MAX_TILT_DEG,
  MIN_TILT_DEG,
  PAPERS,
  noticeTilt,
  paperVariant,
} from './paper';

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

  it('кожен обрис трапляється з кожною остачею id % 6', () => {
    const pairs = new Set<string>();
    for (let id = 0; id < 36; id++) pairs.add(`${id % 6}:${paperVariant(id)}`);
    expect(pairs.size).toBe(36);
  });
});

describe('noticeTilt', () => {
  it('у межах кутів і зсуву, стабільний, з обома напрямками й різними кутами', () => {
    const angles = new Set<number>();
    let left = 0;
    let right = 0;
    for (let id = 1; id <= 200; id++) {
      const { angle, shift } = noticeTilt(id);
      expect(Math.abs(angle)).toBeLessThanOrEqual(MAX_TILT_DEG);
      expect(Math.abs(angle)).toBeGreaterThanOrEqual(MIN_TILT_DEG);
      expect(shift).toBeGreaterThanOrEqual(0);
      expect(shift).toBeLessThanOrEqual(MAX_SHIFT_PX);
      expect(noticeTilt(id)).toEqual({ angle, shift });
      angles.add(angle);
      if (angle < 0) left++;
      else right++;
    }
    expect(angles.size).toBeGreaterThan(30);
    expect(left).toBeGreaterThan(60);
    expect(right).toBeGreaterThan(60);
  });

  it('у сусідніх id кути не йдуть рівним кроком', () => {
    const diffs = new Set<number>();
    for (let id = 1; id < 30; id++) diffs.add(noticeTilt(id + 1).angle - noticeTilt(id).angle);
    expect(diffs.size).toBeGreaterThan(10);
  });
});
