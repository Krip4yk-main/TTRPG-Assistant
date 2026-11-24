import { describe, expect, it } from 'vitest';
import {
  availabilityInputSchema,
  availabilityUpdateSchema,
  calendarSettingsPatchSchema,
  gameBusyQuerySchema,
  type AvailabilityDto,
} from '../contracts/availability.js';
import { changeTimezoneSchema } from '../contracts/me.js';
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

  it('wraps Sunday -> Monday', () => {
    // Нд 2026-12-06 22:00 – Пн 02:00 Kyiv.
    const s = occ('2026-12-06T20:00:00Z', 240);
    const sun = { weekday: 6 as const, startMin: 1320, endMin: 1440 };
    const a: AvailabilityDto = {
      timezone: 'Europe/Kyiv',
      slots: [sun, { weekday: 0, startMin: 0, endMin: 120 }],
      busyDates: [],
    };
    expect(availabilityFit([s], a)).toBe('full');
    expect(availabilityFit([s], { ...a, slots: [sun] })).toBe('none');
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

describe('availabilityUpdateSchema (PUT /api/me/availability)', () => {
  it('ignores a timezone in the body (read-only) and normalizes', () => {
    const r = availabilityUpdateSchema.parse({
      timezone: 'Asia/Tokyo',
      busyDates: ['2026-12-05', '2026-12-05'],
      slots: [
        { weekday: 0, startMin: 720, endMin: 840 },
        { weekday: 0, startMin: 600, endMin: 720 },
      ],
    });
    expect(r).toEqual({
      slots: [{ weekday: 0, startMin: 600, endMin: 840 }],
      busyDates: ['2026-12-05'],
    });
  });
  it('still rejects overlaps', () => {
    expect(
      availabilityUpdateSchema.safeParse({
        busyDates: [],
        slots: [
          { weekday: 0, startMin: 600, endMin: 780 },
          { weekday: 0, startMin: 720, endMin: 840 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('changeTimezoneSchema', () => {
  it('accepts IANA zones only, no extra keys', () => {
    expect(changeTimezoneSchema.safeParse({ timezone: 'America/New_York' }).success).toBe(true);
    expect(changeTimezoneSchema.safeParse({ timezone: 'Nope/Zone' }).success).toBe(false);
    expect(changeTimezoneSchema.safeParse({}).success).toBe(false);
    expect(changeTimezoneSchema.safeParse({ timezone: 'UTC', x: 1 }).success).toBe(false);
  });
});

describe('availabilityFit — busyIntervals (game busy time)', () => {
  const kyivTue: AvailabilityDto = {
    timezone: 'Europe/Kyiv',
    slots: [{ weekday: 1, startMin: 1140, endMin: 1380 }],
    busyDates: [],
  };
  const busy = (startIso: string, minutes: number) => occ(startIso, minutes);

  it('a session overlapping a busy interval does not fit', () => {
    expect(availabilityFit([tue], kyivTue, [])).toBe('full');
    expect(availabilityFit([tue], kyivTue, [busy('2026-12-01T19:00:00Z', 60)])).toBe('none');
    // Інтервал повністю охоплює сесію.
    expect(availabilityFit([tue], kyivTue, [busy('2026-12-01T16:00:00Z', 600)])).toBe('none');
  });

  it('touching intervals (end === start) do not overlap', () => {
    expect(availabilityFit([tue], kyivTue, [busy('2026-12-01T21:00:00Z', 60)])).toBe('full');
    expect(availabilityFit([tue], kyivTue, [busy('2026-12-01T16:00:00Z', 60)])).toBe('full');
  });

  it('counts towards partial like busy dates', () => {
    const two = [tue, occ('2026-12-08T17:00:00Z', 240)];
    expect(availabilityFit(two, kyivTue, [busy('2026-12-08T18:00:00Z', 30)])).toBe('partial');
  });
});

describe('calendar contracts', () => {
  it('settings patch: boolean only, strict', () => {
    expect(calendarSettingsPatchSchema.safeParse({ calendarAutoBusy: false }).success).toBe(true);
    expect(calendarSettingsPatchSchema.safeParse({ calendarAutoBusy: 'no' }).success).toBe(false);
    expect(calendarSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(calendarSettingsPatchSchema.safeParse({ calendarAutoBusy: true, x: 1 }).success).toBe(
      false,
    );
  });

  it('game-busy query: ISO instants, from < to, span ≤ 93 days', () => {
    const ok = gameBusyQuerySchema.safeParse({
      from: '2026-12-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    });
    expect(ok.success && ok.data.from instanceof Date).toBe(true);
    expect(gameBusyQuerySchema.safeParse({ from: '2026-12-01' }).success).toBe(false);
    expect(
      gameBusyQuerySchema.safeParse({ from: '2026-12-02T00:00:00Z', to: '2026-12-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      gameBusyQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});
