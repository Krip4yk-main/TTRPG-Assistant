import { describe, expect, it } from 'vitest';
import {
  GAME_ACTIONS,
  GAME_PRIVATE_FIELDS,
  GAME_STATUSES,
  gameInputSchema,
  gamePatchSchema,
  pauseInputSchema,
  resumeInputSchema,
  scheduleRuleInputSchema,
  searchFiltersSchema,
} from './games.js';

const TZ = 'Europe/Kyiv';
// 2027-01-04 — понеділок; 17:00Z = 19:00 за Києвом.
const ok = {
  title: 'Прокляття Страда',
  systemId: 1,
  genreId: 1,
  format: 'online',
  kind: 'campaign',
  startsAt: '2027-01-04T17:00:00.000Z',
  durationMinutes: 240,
  recurrence: 'weekly',
  weekdays: [0],
  minPlayers: 2,
  maxPlayers: 5,
};
const parse = (patch: object, tz = TZ) => gameInputSchema(tz).safeParse({ ...ok, ...patch });

describe('gameInputSchema', () => {
  it('accepts a valid game and fills defaults', () => {
    const r = parse({});
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      systemOther: null,
      city: null,
      priceUah: null,
      ageRating: 'none',
      experience: 'any',
      language: 'uk',
      channelLinks: [],
      contentWarningIds: [],
      showWhenFull: false,
    });
  });
  it('re-parses its own output (idempotent)', () => {
    const r = parse({ city: '', priceUah: 0 });
    expect(r.success).toBe(true);
    expect(gameInputSchema(TZ).parse(r.data)).toEqual(r.data);
  });
  it('requires exactly one of systemId/systemOther', () => {
    expect(parse({ systemId: null }).success).toBe(false);
    expect(parse({ systemOther: 'Homebrew' }).success).toBe(false);
    expect(parse({ systemId: null, systemOther: 'Homebrew' }).success).toBe(true);
  });
  it('oneshot allows only recurrence none', () => {
    expect(parse({ kind: 'oneshot' }).success).toBe(false);
    expect(parse({ kind: 'oneshot', recurrence: 'none', weekdays: [] }).success).toBe(true);
  });
  it('offline requires city', () => {
    expect(parse({ format: 'offline' }).success).toBe(false);
    expect(parse({ format: 'offline', city: 'Львів' }).success).toBe(true);
  });
  it('cover and channel links must be https', () => {
    expect(parse({ coverUrl: 'http://x.test/a.png' }).success).toBe(false);
    expect(parse({ coverUrl: 'https://x.test/a.png' }).success).toBe(true);
    expect(
      parse({ channelLinks: [{ label: 'Discord', url: 'http://discord.gg/x' }] }).success,
    ).toBe(false);
    const six = Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://a.test' }));
    expect(parse({ channelLinks: six }).success).toBe(false);
  });
  it('duration 30..720 step 30; players 1 ≤ min ≤ max ≤ 20', () => {
    expect(parse({ durationMinutes: 45 }).success).toBe(false);
    expect(parse({ durationMinutes: 750 }).success).toBe(false);
    expect(parse({ minPlayers: 6, maxPlayers: 5 }).success).toBe(false);
    expect(parse({ maxPlayers: 21 }).success).toBe(false);
  });
  it('weekly/biweekly require weekdays containing the weekday of startsAt (game tz)', () => {
    expect(parse({ weekdays: [] }).success).toBe(false);
    expect(parse({ weekdays: [2] }).success).toBe(false);
    expect(parse({ recurrence: 'biweekly', weekdays: [0, 3] }).success).toBe(true);
    // 2027-01-04T23:30Z — це вже вівторок у Києві.
    expect(parse({ startsAt: '2027-01-04T23:30:00.000Z', weekdays: [0] }).success).toBe(false);
    expect(parse({ startsAt: '2027-01-04T23:30:00.000Z', weekdays: [1] }).success).toBe(true);
    expect(
      parse({ startsAt: '2027-01-04T23:30:00.000Z', weekdays: [0] }, 'Europe/London').success,
    ).toBe(true);
  });
  it('none/monthly require empty weekdays', () => {
    expect(parse({ recurrence: 'monthly' }).success).toBe(false);
    expect(parse({ recurrence: 'monthly', weekdays: [] }).success).toBe(true);
    expect(parse({ recurrence: 'none', weekdays: [] }).success).toBe(true);
  });
  it('startsAt must be a whole minute', () => {
    expect(parse({ startsAt: '2027-01-04T17:00:30.000Z' }).success).toBe(false);
    expect(parse({ startsAt: '2027-01-04T17:00:00.500Z' }).success).toBe(false);
    expect(parse({ startsAt: 'tomorrow' }).success).toBe(false);
  });
  it('startsAt may be null (draft without a date); weekly rule then needs only non-empty weekdays', () => {
    expect(parse({ startsAt: null }).data?.startsAt).toBeNull();
    expect(parse({ startsAt: null, weekdays: [2, 4] }).success).toBe(true);
    expect(parse({ startsAt: null, weekdays: [] }).success).toBe(false);
    expect(parse({ startsAt: null, recurrence: 'none', weekdays: [] }).success).toBe(true);
    expect(gameInputSchema(TZ).safeParse({ ...ok, startsAt: undefined }).success).toBe(false);
    expect(gamePatchSchema.parse({ startsAt: null })).toEqual({ startsAt: null });
    expect(scheduleRuleInputSchema.safeParse({ startsAt: null, recurrence: 'none' }).success).toBe(
      false,
    );
    expect(resumeInputSchema.safeParse({ startsAt: null, recruit: false }).success).toBe(false);
  });
  it('limits application questions and custom warnings', () => {
    expect(parse({ applicationQuestions: Array(11).fill('q') }).success).toBe(false);
    expect(parse({ applicationQuestions: ['x'.repeat(301)] }).success).toBe(false);
    expect(parse({ customWarnings: ['x'.repeat(61)] }).success).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(parse({ timezone: 'Europe/Kyiv' }).success).toBe(false);
    expect(parse({ status: 'recruiting' }).success).toBe(false);
  });
});

describe('gamePatchSchema', () => {
  it('accepts partial patches without filling defaults', () => {
    expect(gamePatchSchema.parse({ title: 'New' })).toEqual({ title: 'New' });
  });
  it('validates field shapes', () => {
    expect(gamePatchSchema.safeParse({ coverUrl: 'http://a.test' }).success).toBe(false);
    expect(gamePatchSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe('scheduleRuleInputSchema', () => {
  it('normalizes startsAt, defaults weekdays, keeps duration optional', () => {
    expect(
      scheduleRuleInputSchema.parse({
        startsAt: '2027-01-07T19:00:00+02:00',
        recurrence: 'monthly',
      }),
    ).toEqual({ startsAt: '2027-01-07T17:00:00.000Z', recurrence: 'monthly', weekdays: [] });
    expect(
      scheduleRuleInputSchema.parse({
        startsAt: '2027-01-07T17:00:00Z',
        recurrence: 'weekly',
        weekdays: [3, 1, 3],
        durationMinutes: 180,
      }),
    ).toMatchObject({ weekdays: [1, 3], durationMinutes: 180 });
  });
  it('rejects unknown keys, odd durations and non-whole minutes', () => {
    const base = { startsAt: '2027-01-07T17:00:00Z', recurrence: 'weekly', weekdays: [3] };
    expect(scheduleRuleInputSchema.safeParse({ ...base, kind: 'campaign' }).success).toBe(false);
    expect(scheduleRuleInputSchema.safeParse({ ...base, durationMinutes: 45 }).success).toBe(false);
    expect(
      scheduleRuleInputSchema.safeParse({ ...base, startsAt: '2027-01-07T17:00:10Z' }).success,
    ).toBe(false);
  });
});

describe('searchFiltersSchema', () => {
  it('fills defaults', () => {
    expect(searchFiltersSchema.parse({})).toEqual({
      sort: 'soonest',
      limit: 20,
      priceMode: 'any',
      calendar: { mode: 'off', includePartial: false },
    });
  });
  it('bounds limit to 1–50', () => {
    expect(searchFiltersSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(searchFiltersSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(searchFiltersSchema.parse({ limit: 50 }).limit).toBe(50);
  });
  it('trims city and treats blank as absent', () => {
    expect(searchFiltersSchema.parse({ city: '  Київ ' }).city).toBe('Київ');
    expect(searchFiltersSchema.parse({ city: '  ' }).city).toBeUndefined();
  });
  it('custom calendar requires availability; off/mine forbid it', () => {
    const availability = { timezone: 'Europe/Kyiv', slots: [], busyDates: [] };
    expect(searchFiltersSchema.safeParse({ calendar: { mode: 'custom' } }).success).toBe(false);
    expect(
      searchFiltersSchema.safeParse({ calendar: { mode: 'custom', availability } }).success,
    ).toBe(true);
    expect(
      searchFiltersSchema.safeParse({ calendar: { mode: 'mine', availability } }).success,
    ).toBe(false);
  });
  it('limits the date window to 366 days', () => {
    const ok = { dateFrom: '2027-01-01T00:00:00Z', dateTo: '2028-01-01T00:00:00Z' };
    expect(searchFiltersSchema.safeParse(ok).success).toBe(true);
    const tooLong = { dateFrom: '2027-01-01T00:00:00Z', dateTo: '2028-01-03T00:00:00Z' };
    expect(searchFiltersSchema.safeParse(tooLong).success).toBe(false);
    const empty = { dateFrom: '2027-01-01T00:00:00Z', dateTo: '2027-01-01T00:00:00Z' };
    expect(searchFiltersSchema.safeParse(empty).success).toBe(false);
  });
  it('rejects unknown keys and dateFrom after dateTo', () => {
    expect(searchFiltersSchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(
      searchFiltersSchema.safeParse({
        dateFrom: '2027-01-10T00:00:00Z',
        dateTo: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('campaign pause contracts', () => {
  it('adds the paused status, pause/resume actions and hides the reason from outsiders', () => {
    expect(GAME_STATUSES).toContain('paused');
    expect(GAME_ACTIONS).toEqual(expect.arrayContaining(['pause', 'resume']));
    expect(GAME_PRIVATE_FIELDS).toEqual(expect.arrayContaining(['pauseReason', 'pauseNote']));
  });

  it('pauseInputSchema: reason from the list, optional note ≤ 300 (empty → null)', () => {
    expect(pauseInputSchema.parse({ reason: 'vacation' })).toEqual({
      reason: 'vacation',
      note: null,
    });
    expect(pauseInputSchema.parse({ reason: 'other', note: '  до березня ' })).toEqual({
      reason: 'other',
      note: 'до березня',
    });
    expect(pauseInputSchema.parse({ reason: 'illness', note: '' }).note).toBeNull();
    expect(pauseInputSchema.safeParse({ reason: 'bored' }).success).toBe(false);
    expect(pauseInputSchema.safeParse({}).success).toBe(false);
    expect(pauseInputSchema.safeParse({ reason: 'other', note: 'x'.repeat(301) }).success).toBe(
      false,
    );
    expect(pauseInputSchema.safeParse({ reason: 'other', extra: 1 }).success).toBe(false);
  });

  it('resumeInputSchema: whole-minute startsAt (normalized to UTC) and boolean recruit', () => {
    expect(
      resumeInputSchema.parse({ startsAt: '2027-01-04T19:00:00+02:00', recruit: true }),
    ).toEqual({ startsAt: '2027-01-04T17:00:00.000Z', recruit: true });
    expect(
      resumeInputSchema.safeParse({ startsAt: '2027-01-04T17:00:30Z', recruit: false }).success,
    ).toBe(false);
    expect(resumeInputSchema.safeParse({ startsAt: '2027-01-04T17:00:00Z' }).success).toBe(false);
    expect(
      resumeInputSchema.safeParse({ startsAt: '2027-01-04T17:00:00Z', recruit: 'yes' }).success,
    ).toBe(false);
  });
});
