import { describe, expect, it } from 'vitest';
import { expandOccurrences, type ScheduleInput } from './occurrences.js';

const iso = (xs: { start: Date }[]) => xs.map((x) => x.start.toISOString());
const d = (s: string) => new Date(s);

describe('expandOccurrences', () => {
  it('weekly Tue+Thu from 2026-12-01 19:00 Kyiv', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-01T17:00:00Z',
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [1, 3],
      timezone: 'Europe/Kyiv',
    };
    const occ = expandOccurrences(s, d('2026-12-01T00:00:00Z'), d('2026-12-15T00:00:00Z'));
    expect(iso(occ)).toEqual([
      '2026-12-01T17:00:00.000Z',
      '2026-12-03T17:00:00.000Z',
      '2026-12-08T17:00:00.000Z',
      '2026-12-10T17:00:00.000Z',
    ]);
    expect(occ[0]!.end.toISOString()).toBe('2026-12-01T21:00:00.000Z');
  });

  it('keeps local game time across the DST switch (Review Focus 1)', () => {
    const s: ScheduleInput = {
      startsAt: '2027-03-21T17:00:00Z',
      durationMinutes: 180,
      recurrence: 'weekly',
      weekdays: [6],
      timezone: 'Europe/Kyiv',
    };
    const occ = expandOccurrences(s, d('2027-03-21T00:00:00Z'), d('2027-04-01T00:00:00Z'));
    expect(iso(occ)).toEqual(['2027-03-21T17:00:00.000Z', '2027-03-28T16:00:00.000Z']);
  });

  it('biweekly skips odd weeks counted from the first session week', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-01T17:00:00Z',
      durationMinutes: 120,
      recurrence: 'biweekly',
      weekdays: [1, 3],
      timezone: 'Europe/Kyiv',
    };
    const occ = expandOccurrences(s, d('2026-12-01T00:00:00Z'), d('2026-12-29T00:00:00Z'));
    expect(iso(occ)).toEqual([
      '2026-12-01T17:00:00.000Z',
      '2026-12-03T17:00:00.000Z',
      '2026-12-15T17:00:00.000Z',
      '2026-12-17T17:00:00.000Z',
    ]);
  });

  it('monthly: second Saturday', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-12T16:00:00Z',
      durationMinutes: 240,
      recurrence: 'monthly',
      weekdays: [],
      timezone: 'Europe/Kyiv',
    };
    const occ = expandOccurrences(s, d('2026-12-01T00:00:00Z'), d('2027-03-01T00:00:00Z'));
    expect(iso(occ)).toEqual([
      '2026-12-12T16:00:00.000Z',
      '2027-01-09T16:00:00.000Z',
      '2027-02-13T16:00:00.000Z',
    ]);
  });

  it('monthly: 5th Saturday continues as the last Saturday', () => {
    const s: ScheduleInput = {
      startsAt: '2027-01-30T16:00:00Z',
      durationMinutes: 240,
      recurrence: 'monthly',
      weekdays: [],
      timezone: 'Europe/Kyiv',
    };
    const occ = expandOccurrences(s, d('2027-01-01T00:00:00Z'), d('2027-04-01T00:00:00Z'));
    // 27 березня 2027 Kyiv ще на зимовому часі (перехід 28-го).
    expect(iso(occ)).toEqual([
      '2027-01-30T16:00:00.000Z',
      '2027-02-27T16:00:00.000Z',
      '2027-03-27T16:00:00.000Z',
    ]);
  });

  it('none: exactly one session if in range, otherwise none', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-01T17:00:00Z',
      durationMinutes: 240,
      recurrence: 'none',
      weekdays: [],
      timezone: 'Europe/Kyiv',
    };
    expect(iso(expandOccurrences(s, d('2026-11-01T00:00:00Z'), d('2027-01-01T00:00:00Z')))).toEqual(
      ['2026-12-01T17:00:00.000Z'],
    );
    expect(expandOccurrences(s, d('2026-12-02T00:00:00Z'), d('2027-01-01T00:00:00Z'))).toEqual([]);
  });

  it('range is half-open [from, to)', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-01T17:00:00Z',
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [1],
      timezone: 'Europe/Kyiv',
    };
    expect(iso(expandOccurrences(s, d('2026-12-01T17:00:00Z'), d('2026-12-15T17:00:00Z')))).toEqual(
      ['2026-12-01T17:00:00.000Z', '2026-12-08T17:00:00.000Z'],
    );
  });

  it('never yields sessions before startsAt', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-03T17:00:00Z',
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [1, 3],
      timezone: 'Europe/Kyiv',
    };
    expect(iso(expandOccurrences(s, d('2026-11-01T00:00:00Z'), d('2026-12-09T00:00:00Z')))).toEqual(
      ['2026-12-03T17:00:00.000Z', '2026-12-08T17:00:00.000Z'],
    );
  });

  it('weekly with empty weekdays yields nothing (game schema must reject it)', () => {
    const s: ScheduleInput = {
      startsAt: '2026-12-01T17:00:00Z',
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [],
      timezone: 'Europe/Kyiv',
    };
    expect(expandOccurrences(s, d('2026-11-01T00:00:00Z'), d('2027-01-01T00:00:00Z'))).toEqual([]);
  });
});
