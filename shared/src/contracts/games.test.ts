import { describe, expect, it } from 'vitest';
import { gameInputSchema, gamePatchSchema } from './games.js';

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
