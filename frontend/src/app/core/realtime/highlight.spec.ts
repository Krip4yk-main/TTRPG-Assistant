import { HIGHLIGHT_MS, Highlighter, changedKeys } from './highlight';

describe('highlight', () => {
  it('changedKeys: added and changed items, ignoring the seen marker', () => {
    const prev = [
      { id: 1, t: 'a', seen: 'new' },
      { id: 2, t: 'b', seen: 'seen' },
    ];
    const next = [
      { id: 1, t: 'a', seen: 'seen' },
      { id: 2, t: 'B', seen: 'seen' },
      { id: 3, t: 'c', seen: 'new' },
    ];
    expect(changedKeys(prev, next, (x) => x.id)).toEqual([2, 3]);
    expect(changedKeys(null, next, (x) => x.id)).toEqual([]);
  });

  it('Highlighter clears itself after HIGHLIGHT_MS', () => {
    vi.useFakeTimers();
    try {
      const h = new Highlighter<number>();
      h.flash([1]);
      expect(h.has(1)).toBe(true);
      vi.advanceTimersByTime(HIGHLIGHT_MS);
      expect(h.has(1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
