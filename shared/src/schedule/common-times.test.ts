import { describe, expect, it } from 'vitest';
import { commonTimesQuerySchema } from '../contracts/scheduling.js';
import {
  commonTimesGrid,
  commonTimesWindow,
  evaluateGrid,
  findCommonTimes,
  regularStatus,
  type CommonTimesPerson,
} from './common-times.js';

const KYIV = 'Europe/Kyiv';
const DAY = 86_400_000;
// Пн 2027-03-15 00:00 Kyiv (UTC+2). Перехід на літній час у Європі — нд 2027-03-28.
const FROM = new Date('2027-03-14T22:00:00Z');
const TO = new Date(FROM.getTime() + 28 * DAY);
const TUE = 1 as const;
const H = (h: number) => h * 60;

const person = (p: Partial<CommonTimesPerson> & { userId: number }): CommonTimesPerson => ({
  timezone: KYIV,
  slots: [],
  busyDates: [],
  busy: [],
  hasCalendar: (p.slots?.length ?? 0) > 0,
  ...p,
});

const run = (people: CommonTimesPerson[], extra: { from?: Date; to?: Date } = {}) =>
  findCommonTimes({
    timezone: KYIV,
    durationMinutes: 240,
    from: extra.from ?? FROM,
    to: extra.to ?? TO,
    people,
  });

describe('commonTimesGrid', () => {
  it('skips the non-existent local hour on the spring DST switch', () => {
    // Нд 2027-03-28 Kyiv: 03:00 → 04:00 (о 01:00 UTC).
    const from = new Date('2027-03-27T22:00:00Z');
    const to = new Date('2027-03-28T21:00:00Z');
    const g = commonTimesGrid(KYIV, from, to, 60);
    expect(g).toHaveLength(46);
    expect(new Set(g.map((p) => p.start.getTime())).size).toBe(46);
    expect(g.some((p) => p.startMin === 180 || p.startMin === 210)).toBe(false);
    expect(g.find((p) => p.startMin === 240)!.start.toISOString()).toBe('2027-03-28T01:00:00.000Z');
  });

  it('keeps candidates inside [from, to)', () => {
    const g = commonTimesGrid(KYIV, FROM, new Date(FROM.getTime() + DAY), 60);
    expect(g).toHaveLength(48);
    expect(g[0]!.start).toEqual(FROM);
    expect(g.at(-1)!.start.toISOString()).toBe('2027-03-15T21:30:00.000Z');
  });
});

describe('commonTimesWindow', () => {
  it('weeks: from now', () => {
    const now = new Date('2027-03-10T10:00:00Z');
    const w = commonTimesWindow(KYIV, now, { weeks: 2 });
    expect(w).toEqual({ from: now, to: new Date(now.getTime() + 14 * DAY) });
  });

  it('weekOf: Monday 00:00 … next Monday in the game zone, clamped to now', () => {
    const now = new Date('2027-03-01T10:00:00Z');
    // Чт 2027-03-25 → тиждень пн 22.03 – пн 29.03 (вже літній час).
    expect(commonTimesWindow(KYIV, now, { weeks: 4, weekOf: '2027-03-25' })).toEqual({
      from: new Date('2027-03-21T22:00:00Z'),
      to: new Date('2027-03-28T21:00:00Z'),
    });
    const mid = new Date('2027-03-24T09:00:00Z');
    expect(commonTimesWindow(KYIV, mid, { weeks: 4, weekOf: '2027-03-25' }).from).toEqual(mid);
  });
});

describe('findCommonTimes', () => {
  it('converts a Warsaw member into the Kyiv game zone across the DST switch (RF 1)', () => {
    const gm = person({ userId: 1, slots: [{ weekday: TUE, startMin: H(19), endMin: H(23) }] });
    // 18:00–22:00 Warsaw = 19:00–23:00 Kyiv (і взимку, і влітку: обидва пояси переходять разом).
    const m = person({
      userId: 2,
      timezone: 'Europe/Warsaw',
      slots: [{ weekday: TUE, startMin: H(18), endMin: H(22) }],
    });
    const r = run([gm, m]);
    expect(r.regular[0]).toMatchObject({
      weekday: TUE,
      startMin: H(19),
      weeks: 4,
      can: 2,
      cannot: 0,
      unknown: 0,
      firstStartsAt: '2027-03-16T17:00:00.000Z',
      statuses: [
        { userId: 1, status: 'can', weeksCan: 4 },
        { userId: 2, status: 'can', weeksCan: 4 },
      ],
    });
    // Разові: кожен вівторок о 19:00 Kyiv; після переходу — 16:00 UTC.
    expect(r.oneOff.map((c) => c.startsAt)).toEqual([
      '2027-03-16T17:00:00.000Z',
      '2027-03-23T17:00:00.000Z',
      '2027-03-30T16:00:00.000Z',
      '2027-04-06T16:00:00.000Z',
    ]);
    expect(r.oneOff.every((c) => c.can === 2)).toBe(true);
  });

  it('evaluates each occurrence when the zones switch DST on different dates (RF 1)', () => {
    // Нью-Йорк переходить 14.03, Київ — 28.03: два тижні різниця 6 год замість 7.
    const ny = person({
      userId: 1,
      timezone: 'America/New_York',
      slots: [{ weekday: TUE, startMin: H(12), endMin: H(16) }],
    });
    const from = new Date('2027-03-07T22:00:00Z'); // пн 08.03 Kyiv
    const r = run([ny], { from, to: new Date(from.getTime() + 28 * DAY) });
    // Вт 19:00 Kyiv = 12:00 NY лише 09.03 і 30.03; 16.03 і 23.03 — 13:00 NY (поза слотом).
    const tue19 = findCommonTimes({
      timezone: KYIV,
      durationMinutes: 240,
      from,
      to: new Date(from.getTime() + 28 * DAY),
      people: [ny],
      top: 1000,
    }).regular.find((c) => c.weekday === TUE && c.startMin === H(19));
    // Лише 2 з 4 тижнів — не більшість → «не може», нікого «може» — не пропонується.
    expect(tue19).toBeUndefined();
    expect(r.regular).toEqual([]);
    expect(r.oneOff.map((c) => c.startsAt).sort()).toEqual([
      '2027-03-09T17:00:00.000Z', // 19:00 Kyiv = 12:00 NY
      '2027-03-16T16:00:00.000Z', // 18:00 Kyiv = 12:00 NY (EDT)
      '2027-03-23T16:00:00.000Z',
      '2027-03-30T16:00:00.000Z', // 19:00 Kyiv (EEST) = 12:00 NY
    ]);
  });

  it('autumn: one week shifted by the US/EU DST gap is a per-week miss, not a veto', () => {
    // ЄС переходить на зимовий час 31.10.2027, США — 07.11: вт 02.11 різниця 6 год, не 7.
    const ny = person({
      userId: 1,
      timezone: 'America/New_York',
      slots: [{ weekday: TUE, startMin: H(12), endMin: H(16) }],
    });
    const from = new Date('2027-10-17T21:00:00Z'); // пн 18.10 00:00 Kyiv (EEST)
    const r = run([ny], { from, to: new Date(from.getTime() + 28 * DAY) });
    expect(r.regular[0]).toMatchObject({
      weekday: TUE,
      startMin: H(19),
      weeks: 4,
      can: 1,
      statuses: [{ userId: 1, status: 'can', weeksCan: 3, outsideSlotsWeeks: 1 }],
    });
    // 02.11 о 19:00 Kyiv = 13:00 NY — поза слотом; разовий кандидат того тижня — 18:00 Kyiv.
    expect(r.oneOff.map((c) => c.startsAt)).not.toContain('2027-11-02T17:00:00.000Z');
    expect(r.oneOff.map((c) => c.startsAt)).toContain('2027-11-02T16:00:00.000Z');
  });

  it('spring DST night: the session overruns the slots that week only', () => {
    // Сб 23:00 Kyiv, 4 год: зазвичай до 03:00, у ніч 27→28.03 — до 04:00 (03:00 → 04:00).
    const night = person({
      userId: 1,
      slots: [
        { weekday: 5, startMin: H(23), endMin: 1440 },
        { weekday: 6, startMin: 0, endMin: H(3) },
      ],
    });
    const r = run([night]);
    expect(r.regular).toHaveLength(1);
    expect(r.regular[0]).toMatchObject({
      weekday: 5,
      startMin: H(23),
      weeks: 4,
      statuses: [{ userId: 1, status: 'can', weeksCan: 3, outsideSlotsWeeks: 1 }],
    });
    expect(r.oneOff.map((c) => c.startsAt)).not.toContain('2027-03-27T21:00:00.000Z');
    expect(r.oneOff).toHaveLength(3);
  });

  it('regular picks do not overlap across midnight', () => {
    const p = person({
      userId: 1,
      slots: [
        { weekday: 0, startMin: H(22), endMin: 1440 },
        { weekday: 1, startMin: 0, endMin: H(4) },
      ],
    });
    // Пн 22:00 … вт 00:00 — усі вміщуються (4 год), але перетинаються між собою.
    expect(run([p]).regular.map((c) => [c.weekday, c.startMin])).toEqual([[0, H(22)]]);
  });

  it('empty calendar → unknown, never can; nothing to propose without any «can» (RF 5)', () => {
    const empty = person({ userId: 1 });
    expect(run([empty])).toEqual({ regular: [], oneOff: [] });
    const gm = person({ userId: 2, slots: [{ weekday: TUE, startMin: H(19), endMin: H(23) }] });
    const r = run([empty, gm]);
    expect(r.regular[0]).toMatchObject({
      can: 1,
      unknown: 1,
      statuses: [
        { userId: 1, status: 'unknown', weeksCan: 0 },
        { userId: 2, status: 'can', weeksCan: 4 },
      ],
    });
    expect(r.oneOff[0]!.statuses[0]).toEqual({ userId: 1, status: 'unknown' });
  });

  it('another game blocks its date only; a person without slots but with a conflict → cannot', () => {
    const slots = [{ weekday: TUE, startMin: H(19), endMin: H(23) }];
    // Сесія іншої гри у вт 23.03 20:00–22:00 Kyiv.
    const busy = [
      { start: new Date('2027-03-23T18:00:00Z'), end: new Date('2027-03-23T20:00:00Z') },
    ];
    const a = person({ userId: 1, slots, busy });
    const b = person({ userId: 2, busy });
    const r = run([a, b]);
    expect(r.regular[0]).toMatchObject({
      weekday: TUE,
      startMin: H(19),
      statuses: [
        { userId: 1, status: 'can', weeksCan: 3 },
        { userId: 2, status: 'unknown', weeksCan: 0 },
      ],
    });
    expect(r.oneOff.map((c) => c.startsAt)).not.toContain('2027-03-23T17:00:00.000Z');
    // Точка 23.03 19:00: обидва «не можуть» (b — без календаря, але з відомим конфліктом).
    const points = commonTimesGrid(KYIV, FROM, TO, 240);
    const i = points.findIndex((p) => p.start.toISOString() === '2027-03-23T17:00:00.000Z');
    expect(evaluateGrid(points, [a, b]).map((v) => v[i]!.status)).toEqual(['cannot', 'cannot']);
  });

  it('busy date removes one week; busy every week → cannot', () => {
    const slots = [{ weekday: TUE, startMin: H(19), endMin: H(23) }];
    const one = person({ userId: 1, slots, busyDates: ['2027-03-30'] });
    expect(run([one]).regular[0]!.statuses[0]).toEqual({
      userId: 1,
      status: 'can',
      weeksCan: 3,
      outsideSlotsWeeks: 0,
    });
    const half = person({ userId: 1, slots, busyDates: ['2027-03-16', '2027-03-23'] });
    expect(run([half]).regular).toEqual([]);
  });

  it('ranks by most can, then fewest cannot, then earliest; picks do not overlap', () => {
    const wide = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday: weekday as 0,
      startMin: 0,
      endMin: 1440,
    }));
    const a = person({ userId: 1, slots: wide });
    // b: лише вт 19–23 і ср 19–23; c — без календаря, але в ср зайнятий іншою грою.
    const b = person({
      userId: 2,
      slots: [
        { weekday: 1, startMin: H(19), endMin: H(23) },
        { weekday: 2, startMin: H(19), endMin: H(23) },
      ],
    });
    const c = person({
      userId: 3,
      busy: [{ start: new Date('2027-03-17T17:00:00Z'), end: new Date('2027-03-17T21:00:00Z') }],
    });
    const r = run([a, b, c]);
    // Вт і ср мають по 2 «може»; у ср 17.03 у c конфлікт → вт попереду.
    expect(r.oneOff[0]!.startsAt).toBe('2027-03-16T17:00:00.000Z');
    expect(r.oneOff[0]).toMatchObject({ can: 2, cannot: 0, unknown: 1 });
    const starts = r.oneOff.map((x) => Date.parse(x.startsAt));
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        expect(Math.abs(starts[i]! - starts[j]!)).toBeGreaterThanOrEqual(240 * 60_000);
      }
    }
    expect(r.oneOff).toHaveLength(5);
    // Регулярні: вт і ср 19:00 (2 «може»); далі — кандидати з одним «може», без перетинів.
    expect(r.regular.slice(0, 2).map((x) => [x.weekday, x.startMin])).toEqual([
      [1, H(19)],
      [2, H(19)],
    ]);
    expect(r.regular[1]!.statuses[2]).toEqual({
      userId: 3,
      status: 'unknown',
      weeksCan: 0,
      outsideSlotsWeeks: 0,
    });
    expect(r.regular).toHaveLength(5);
  });

  it('excludeOneOff drops candidates before the top is picked (neighbours are not blocked)', () => {
    const a = person({ userId: 1, slots: [{ weekday: TUE, startMin: H(18), endMin: H(23) }] });
    const base = { timezone: KYIV, durationMinutes: 240, from: FROM, to: TO, people: [a] };
    const plain = findCommonTimes({ ...base, regular: false, top: 1 });
    expect(plain.oneOff[0]!.startsAt).toBe('2027-03-16T16:00:00.000Z');
    const cur = Date.parse('2027-03-16T16:00:00.000Z');
    const r = findCommonTimes({
      ...base,
      regular: false,
      top: 2,
      excludeOneOff: (start) => start.getTime() === cur,
    });
    // 18:30 перетинається з виключеним 18:00, але сам не виключений — його пропонують.
    expect(r.oneOff[0]!.startsAt).toBe('2027-03-16T16:30:00.000Z');
    expect(r.oneOff.map((x) => x.startsAt)).not.toContain('2027-03-16T16:00:00.000Z');
  });

  it('regular: no regular candidates when disabled (oneshot)', () => {
    const a = person({ userId: 1, slots: [{ weekday: TUE, startMin: H(19), endMin: H(23) }] });
    const r = findCommonTimes({
      timezone: KYIV,
      durationMinutes: 240,
      from: FROM,
      to: TO,
      people: [a],
      regular: false,
    });
    expect(r.regular).toEqual([]);
    expect(r.oneOff).toHaveLength(4);
  });
});

describe('regularStatus', () => {
  const v = (status: 'can' | 'cannot' | 'unknown', outsideSlots = false) => ({
    status,
    outsideSlots,
  });
  it('majority of weeks; outside-slot weeks count as misses and are reported', () => {
    expect(regularStatus([v('can'), v('cannot', true)]).status).toBe('cannot');
    expect(regularStatus([v('can'), v('can'), v('can'), v('cannot', true)])).toEqual({
      status: 'can',
      weeksCan: 3,
      outsideSlotsWeeks: 1,
    });
    expect(regularStatus([v('can'), v('can'), v('cannot')])).toEqual({
      status: 'can',
      weeksCan: 2,
      outsideSlotsWeeks: 0,
    });
    expect(regularStatus([v('can'), v('cannot')]).status).toBe('cannot');
    expect(regularStatus([v('unknown'), v('unknown')]).status).toBe('unknown');
    expect(regularStatus([v('unknown'), v('unknown'), v('cannot')]).status).toBe('unknown');
    expect(regularStatus([v('unknown'), v('cannot')]).status).toBe('cannot');
  });
});

describe('commonTimesQuerySchema', () => {
  it('weeks 1–8, weekOf date, not both', () => {
    expect(commonTimesQuerySchema.parse({})).toEqual({});
    expect(commonTimesQuerySchema.parse({ weeks: '8' })).toEqual({ weeks: 8 });
    expect(commonTimesQuerySchema.safeParse({ weeks: '0' }).success).toBe(false);
    expect(commonTimesQuerySchema.safeParse({ weeks: '9' }).success).toBe(false);
    expect(commonTimesQuerySchema.parse({ weekOf: '2027-03-25' })).toEqual({
      weekOf: '2027-03-25',
    });
    expect(commonTimesQuerySchema.safeParse({ weekOf: '2027-02-30' }).success).toBe(false);
    expect(commonTimesQuerySchema.safeParse({ weeks: '2', weekOf: '2027-03-25' }).success).toBe(
      false,
    );
    expect(commonTimesQuerySchema.safeParse({ x: '1' }).success).toBe(false);
  });
});

describe('import-only participants (iCal without weekly slots)', () => {
  it('«can» only within 09:00–24:00 of their own zone; a night candidate is not ranked first', () => {
    const gm = person({
      userId: 1,
      slots: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d as 0, startMin: 0, endMin: 1440 })),
    });
    // Лише імпорт, жодних подій: раніше «може» цілодобово — і нічний 00:00 вигравав (раніший час).
    const imp = person({ userId: 2, hasCalendar: true });
    const day = new Date('2027-03-15T22:00:00Z'); // вт 00:00 Kyiv
    const dto = findCommonTimes({
      timezone: KYIV,
      durationMinutes: 120,
      from: day,
      to: new Date(day.getTime() + DAY),
      people: [gm, imp],
      regular: false,
    });
    const first = dto.oneOff[0]!;
    expect(first.can).toBe(2);
    // 09:00 Kyiv — найраніший час, коли обоє «можуть».
    expect(first.startsAt).toBe('2027-03-16T07:00:00.000Z');
    for (const c of dto.oneOff) {
      const local = new Date(Date.parse(c.startsAt) + 2 * 3_600_000).getUTCHours();
      if (local < 9) expect(c.statuses[1]!.status).toBe('unknown');
    }

    const [v] = evaluateGrid(
      [
        {
          start: new Date('2027-03-16T06:30:00Z'),
          end: new Date('2027-03-16T08:30:00Z'),
          startMin: 0,
        },
        {
          start: new Date('2027-03-16T07:00:00Z'),
          end: new Date('2027-03-16T09:00:00Z'),
          startMin: 0,
        },
        {
          start: new Date('2027-03-16T20:00:00Z'),
          end: new Date('2027-03-16T22:00:00Z'),
          startMin: 0,
        },
        {
          start: new Date('2027-03-16T21:00:00Z'),
          end: new Date('2027-03-16T23:00:00Z'),
          startMin: 0,
        },
      ] as never,
      [imp],
    );
    // 08:30–10:30 — починається до 09:00; 09:00–11:00 — так; 22:00–24:00 — так; 23:00–01:00 — ні.
    expect(v!.map((x) => x.status)).toEqual(['unknown', 'can', 'can', 'unknown']);
    // Події з імпорту однаково «не може», зокрема й уночі.
    const busyNight = person({
      userId: 3,
      hasCalendar: true,
      busy: [{ start: new Date('2027-03-16T00:00:00Z'), end: new Date('2027-03-16T02:00:00Z') }],
    });
    const [b] = evaluateGrid(
      [
        {
          start: new Date('2027-03-16T00:30:00Z'),
          end: new Date('2027-03-16T01:30:00Z'),
          startMin: 0,
        },
      ] as never,
      [busyNight],
    );
    expect(b![0]!.status).toBe('cannot');
  });

  it('the waking window follows the participant zone, not the game zone', () => {
    const ny = person({ userId: 2, hasCalendar: true, timezone: 'America/New_York' });
    // 16:00 Kyiv = 10:00 New York (березень 2027: NY уже на літньому, UTC-4; Kyiv UTC+2).
    const [v] = evaluateGrid(
      [
        {
          start: new Date('2027-03-16T14:00:00Z'),
          end: new Date('2027-03-16T16:00:00Z'),
          startMin: 0,
        },
        {
          start: new Date('2027-03-16T07:00:00Z'),
          end: new Date('2027-03-16T09:00:00Z'),
          startMin: 0,
        },
      ] as never,
      [ny],
    );
    expect(v!.map((x) => x.status)).toEqual(['can', 'unknown']);
  });
});
