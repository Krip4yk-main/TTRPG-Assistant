import { describe, expect, it } from 'vitest';
import { availabilityInputSchema, type AvailabilityDto } from '../contracts/availability.js';
import { availabilityFit, FIT_HORIZON_DAYS } from './fit.js';

const occ = (startIso: string, minutes: number) => {
  const start = new Date(startIso);
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
};
// 19:00–23:00 Kyiv, вівторок 2026-12-01 (= 18:00–22:00 Warsaw).
const tue = occ('2026-12-01T17:00:00Z', 240);

describe('availabilityFit', () => {
  it('exposes the 4-week horizon', () => {
    expect(FIT_HORIZON_DAYS).toBe(28);
  });

  it('converts into the player zone (Review Focus 2)', () => {
    const a = (startMin: number): AvailabilityDto => ({
      timezone: 'Europe/Warsaw',
      slots: [{ weekday: 1, startMin, endMin: 1320 }],
      busyDates: [],
    });
    expect(availabilityFit([tue], a(1080))).toBe('full');
    expect(availabilityFit([tue], a(1110))).toBe('none');
  });

  const kyivTue: AvailabilityDto = {
    timezone: 'Europe/Kyiv',
    slots: [{ weekday: 1, startMin: 1140, endMin: 1380 }],
    busyDates: [],
  };
  const fourWeeks = [
    occ('2026-12-01T17:00:00Z', 240),
    occ('2026-12-08T17:00:00Z', 240),
    occ('2026-12-15T17:00:00Z', 240),
    occ('2026-12-22T17:00:00Z', 240),
  ];

  it('partial when at least half fit, none when fewer', () => {
    expect(availabilityFit(fourWeeks, kyivTue)).toBe('full');
    expect(
      availabilityFit(fourWeeks, { ...kyivTue, busyDates: ['2026-12-01', '2026-12-08'] }),
    ).toBe('partial');
    expect(
      availabilityFit(fourWeeks, {
        ...kyivTue,
        busyDates: ['2026-12-01', '2026-12-08', '2026-12-15'],
      }),
    ).toBe('none');
  });

  it('busy date excludes the session', () => {
    expect(availabilityFit([tue], { ...kyivTue, busyDates: ['2026-12-01'] })).toBe('none');
  });

  it('session over midnight fits two adjoining intervals', () => {
    // Пт 2026-12-04 22:00 – Сб 02:00 Kyiv.
    const s = occ('2026-12-04T20:00:00Z', 240);
    const a: AvailabilityDto = {
      timezone: 'Europe/Kyiv',
      slots: [
        { weekday: 4, startMin: 1200, endMin: 1440 },
        { weekday: 5, startMin: 0, endMin: 180 },
      ],
      busyDates: [],
    };
    expect(availabilityFit([s], a)).toBe('full');
    expect(availabilityFit([s], { ...a, slots: [a.slots[0]!] })).toBe('none');
    expect(availabilityFit([s], { ...a, busyDates: ['2026-12-05'] })).toBe('none');
  });

  it('crosses midnight only in the player zone', () => {
    // 20:00–23:30 Kyiv (+2) = Пн 22:00 – Вт 01:30 Asia/Dubai (+4).
    const s = occ('2026-11-30T18:00:00Z', 210);
    const a: AvailabilityDto = {
      timezone: 'Asia/Dubai',
      slots: [
        { weekday: 0, startMin: 1260, endMin: 1440 },
        { weekday: 1, startMin: 0, endMin: 120 },
      ],
      busyDates: [],
    };
    expect(availabilityFit([s], a)).toBe('full');
    expect(
      availabilityFit([s], {
        ...a,
        slots: [a.slots[0]!, { weekday: 1, startMin: 0, endMin: 60 }],
      }),
    ).toBe('none');
  });

  it('session ending exactly at midnight needs only the same day', () => {
    const s = occ('2026-12-01T18:00:00Z', 240); // 20:00–24:00 Kyiv
    expect(
      availabilityFit([s], {
        timezone: 'Europe/Kyiv',
        slots: [{ weekday: 1, startMin: 1200, endMin: 1440 }],
        busyDates: ['2026-12-02'],
      }),
    ).toBe('full');
  });

  it('unmerged adjacent slots still count as one interval', () => {
    expect(
      availabilityFit([tue], {
        timezone: 'Europe/Kyiv',
        slots: [
          { weekday: 1, startMin: 1140, endMin: 1260 },
          { weekday: 1, startMin: 1260, endMin: 1380 },
        ],
        busyDates: [],
      }),
    ).toBe('full');
  });

  it('empty occurrence list -> none', () => {
    expect(availabilityFit([], kyivTue)).toBe('none');
  });
});

describe('availabilityInputSchema', () => {
  const base = { timezone: 'Europe/Kyiv', busyDates: [] as string[] };
  it('rejects non-30-minute steps', () => {
    expect(
      availabilityInputSchema.safeParse({
        ...base,
        slots: [{ weekday: 0, startMin: 15, endMin: 120 }],
      }).success,
    ).toBe(false);
  });
  it('rejects overlapping intervals', () => {
    expect(
      availabilityInputSchema.safeParse({
        ...base,
        slots: [
          { weekday: 0, startMin: 600, endMin: 780 },
          { weekday: 0, startMin: 720, endMin: 840 },
        ],
      }).success,
    ).toBe(false);
  });
  it('rejects start >= end and out-of-range values', () => {
    for (const slot of [
      { weekday: 0, startMin: 600, endMin: 600 },
      { weekday: 0, startMin: 0, endMin: 1470 },
      { weekday: 7, startMin: 0, endMin: 60 },
    ]) {
      expect(availabilityInputSchema.safeParse({ ...base, slots: [slot] }).success).toBe(false);
    }
  });
  it('sorts and merges adjacent intervals, dedupes busy dates', () => {
    const r = availabilityInputSchema.parse({
      timezone: 'Europe/Kyiv',
      busyDates: ['2026-12-05', '2026-12-01', '2026-12-05'],
      slots: [
        { weekday: 2, startMin: 0, endMin: 60 },
        { weekday: 0, startMin: 720, endMin: 840 },
        { weekday: 0, startMin: 600, endMin: 720 },
      ],
    });
    expect(r.slots).toEqual([
      { weekday: 0, startMin: 600, endMin: 840 },
      { weekday: 2, startMin: 0, endMin: 60 },
    ]);
    expect(r.busyDates).toEqual(['2026-12-01', '2026-12-05']);
  });
  it('rejects invalid timezone and busy dates', () => {
    expect(
      availabilityInputSchema.safeParse({ ...base, timezone: 'Nope/Zone', slots: [] }).success,
    ).toBe(false);
    expect(
      availabilityInputSchema.safeParse({ ...base, busyDates: ['2026-02-30'], slots: [] }).success,
    ).toBe(false);
  });
});
