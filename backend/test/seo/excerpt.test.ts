import { describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION, truncateDescription } from '../../src/seo/excerpt.js';

describe('truncateDescription', () => {
  it('short text stays as is (whitespace collapsed to single spaces, trimmed)', () => {
    expect(truncateDescription('Готичний жах у тумані.')).toBe('Готичний жах у тумані.');
    expect(truncateDescription('  Готичний\n\n жах\tу  тумані.  ')).toBe('Готичний жах у тумані.');
  });

  it('empty or blank → empty string (cards turn it into null)', () => {
    expect(truncateDescription('')).toBe('');
    expect(truncateDescription(' \n\t ')).toBe('');
  });

  it('long text is cut at a word boundary with «…», ≤ 200 code points in total', () => {
    const out = truncateDescription(`${'слово '.repeat(60)}кінець`);
    expect(out.endsWith('слово…')).toBe(true);
    expect([...out].length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(out).not.toContain('кінець');
    expect(out).not.toMatch(/ …$/);
  });

  it('trailing punctuation before «…» is dropped', () => {
    const out = truncateDescription(`${'а'.repeat(190)} кінець, далі ще багато слів`, 200);
    expect(out).toBe(`${'а'.repeat(190)} кінець…`);
  });

  it('counts code points: emoji are not split', () => {
    const out = truncateDescription(`${'🐉 '.repeat(150)}`);
    expect([...out].length).toBeLessThanOrEqual(MAX_DESCRIPTION);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.endsWith('🐉…')).toBe(true);
  });

  it('a single long word without spaces is cut hard', () => {
    const out = truncateDescription('я'.repeat(300));
    expect(out).toBe(`${'я'.repeat(199)}…`);
  });
});
