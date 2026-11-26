import { describe, expect, it } from 'vitest';
import { toZoned } from '../schedule/tz.js';
import { nextWeeklyStart, pollCreateSchema, pollVotesSchema, pollWinner } from './polls.js';

describe('nextWeeklyStart', () => {
  it('next weekday + time in the zone, strictly after `after`', () => {
    // 2027-03-24 — середа; пн = 0 → нд = 6.
    const after = new Date('2027-03-24T10:00:00Z');
    const at = nextWeeklyStart('Europe/Kyiv', 2, 19 * 60, after);
    expect(at.toISOString()).toBe('2027-03-24T17:00:00.000Z');
    expect(nextWeeklyStart('Europe/Kyiv', 2, 19 * 60, at).toISOString()).toBe(
      '2027-03-31T16:00:00.000Z', // після переходу на літній час (28.03) — UTC+3
    );
  });

  it('skips a local time that does not exist (spring DST gap)', () => {
    // 2027-03-28 (нд) 03:30 у Києві не існує → наступна неділя.
    const at = nextWeeklyStart('Europe/Kyiv', 6, 3 * 60 + 30, new Date('2027-03-26T00:00:00Z'));
    const z = toZoned(at, 'Europe/Kyiv');
    expect([z.month, z.day, z.hour, z.minute]).toEqual([4, 4, 3, 30]);
  });
});

describe('pollWinner', () => {
  const o = (id: number, yes: number, no: number, maybe: number) => ({
    id,
    position: id,
    yes,
    no,
    maybe,
  });
  it('most yes, then fewest no, then most maybe, then earliest; nothing positive → null', () => {
    expect(pollWinner([o(1, 1, 0, 0), o(2, 2, 3, 0)])).toBe(2);
    expect(pollWinner([o(1, 2, 1, 0), o(2, 2, 0, 0)])).toBe(2);
    expect(pollWinner([o(1, 1, 0, 0), o(2, 1, 0, 1)])).toBe(2);
    expect(pollWinner([o(1, 1, 0, 0), o(2, 1, 0, 0)])).toBe(1);
    expect(pollWinner([o(1, 0, 2, 0), o(2, 0, 0, 0)])).toBeNull();
    expect(pollWinner([o(1, 0, 2, 1), o(2, 0, 0, 0)])).toBe(1);
  });
});

describe('poll schemas', () => {
  const closesAt = '2027-01-01T10:00:30Z';
  it('options match the kind, 2–6, no duplicates', () => {
    const regular = { kind: 'regular', closesAt, options: [{ weekday: 1, startMin: 1140 }] };
    expect(pollCreateSchema.safeParse(regular).success).toBe(false);
    regular.options.push({ weekday: 2, startMin: 1140 });
    expect(pollCreateSchema.safeParse(regular).success).toBe(true);
    expect(pollCreateSchema.safeParse({ ...regular, sessionId: 1 }).success).toBe(false);
    const dup = { kind: 'regular', closesAt, options: [regular.options[0], regular.options[0]] };
    expect(pollCreateSchema.safeParse(dup).success).toBe(false);
    const oneOff = {
      kind: 'one_off',
      closesAt,
      options: [{ startsAt: '2027-01-02T17:00:00Z' }, { startsAt: '2027-01-02T17:00:30Z' }],
    };
    expect(pollCreateSchema.safeParse(oneOff).success).toBe(false); // не ціла хвилина
    expect(
      pollCreateSchema.safeParse({
        ...oneOff,
        options: [oneOff.options[0], { weekday: 1, startMin: 0 }],
      }).success,
    ).toBe(false);
  });

  it('votes: known values, unique options', () => {
    expect(pollVotesSchema.safeParse({ votes: [{ optionId: 1, value: 'yes' }] }).success).toBe(
      true,
    );
    expect(pollVotesSchema.safeParse({ votes: [{ optionId: 1, value: 'going' }] }).success).toBe(
      false,
    );
    expect(
      pollVotesSchema.safeParse({
        votes: [
          { optionId: 1, value: 'yes' },
          { optionId: 1, value: 'no' },
        ],
      }).success,
    ).toBe(false);
    expect(pollVotesSchema.safeParse({ votes: [] }).success).toBe(false);
  });
});
