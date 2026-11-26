import { NEONS, neonOf } from './neon';

describe('neonOf', () => {
  it('стабільний, з набору шести, у сусідніх id — різний', () => {
    for (let id = 0; id < 60; id++) {
      const n = neonOf(id);
      expect(NEONS).toContain(n);
      expect(neonOf(id)).toBe(n);
      expect(neonOf(id + 1)).not.toBe(n);
    }
    expect(neonOf(-7)).toBe(neonOf(7));
  });

  it('усі шість кольорів трапляються в кожній шістці id (6k…6k+5)', () => {
    for (const k of [0, 2, 7]) {
      expect(new Set(Array.from({ length: 6 }, (_, i) => neonOf(6 * k + i))).size).toBe(6);
    }
  });
});
