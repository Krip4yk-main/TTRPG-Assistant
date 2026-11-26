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
    expect(tue19).toBeUndefined(); // нікого «може» — не пропонується
    expect(r.regular).toEqual([]);
    expect(r.oneOff.map((c) => c.startsAt).sort()).toEqual([
      '2027-03-09T17:00:00.000Z', // 19:00 Kyiv = 12:00 NY
      '2027-03-16T16:00:00.000Z', // 18:00 Kyiv = 12:00 NY (EDT)
      '2027-03-23T16:00:00.000Z',
      '2027-03-30T16:00:00.000Z', // 19:00 Kyiv (EEST) = 12:00 NY
    ]);
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
    expect(r.regular[1]!.statuses[2]).toEqual({ userId: 3, status: 'unknown', weeksCan: 0 });
    expect(r.regular).toHaveLength(5);
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
  it('outside slots in any week → cannot; otherwise majority', () => {
    expect(regularStatus([v('can'), v('cannot', true)]).status).toBe('cannot');
    expect(regularStatus([v('can'), v('can'), v('cannot')])).toEqual({
      status: 'can',
      weeksCan: 2,
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
