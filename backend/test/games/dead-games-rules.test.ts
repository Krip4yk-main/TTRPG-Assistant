import { describe, expect, it } from 'vitest';
import {
  overlappingGames,
  staleAnchor,
  staleRule,
  type StaleInput,
} from '../../src/games/dead-games/rules.js';
import { TEST_NOW } from '../test-now.js';

const DAY = 86_400_000;
const NOW = new Date(TEST_NOW);
const ago = (days: number, ms = 0) => new Date(NOW.getTime() - days * DAY - ms);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

const game = (patch: Partial<StaleInput> = {}): StaleInput => ({
  status: 'started',
  publishedAt: ago(200),
  lastDoneAt: null,
  firstSessionAt: ago(200),
  deadSnoozedUntil: null,
  deadExemptUntilSession: false,
  ...patch,
});

describe('staleRule (RF 1: no false «dead»)', () => {
  it('boundaries: > 30 days → remind, > 90 days → dead (exactly 30/90 — not yet)', () => {
    const at = (d: Date) => staleRule(game({ publishedAt: d, firstSessionAt: d }), NOW);
    expect(at(ago(30))).toBe('ok');
    expect(at(ago(30, 1000))).toBe('remind');
    expect(at(ago(90))).toBe('remind');
    expect(at(ago(90, 1000))).toBe('dead');
  });

  it('campaign with a done session 89 days ago is not dead', () => {
    expect(staleRule(game({ lastDoneAt: ago(89) }), NOW)).toBe('remind');
    expect(staleRule(game({ lastDoneAt: ago(10) }), NOW)).toBe('ok');
  });

  it('a game whose first session is in the future is not stale (even if published long ago)', () => {
    expect(staleRule(game({ publishedAt: ago(150), firstSessionAt: ahead(60) }), NOW)).toBe('ok');
    // Перша сесія 20 днів тому, публікація давно — ще ок.
    expect(staleRule(game({ publishedAt: ago(150), firstSessionAt: ago(20) }), NOW)).toBe('ok');
  });

  it('anchor = latest of last done, publication and first session', () => {
    expect(
      staleAnchor({ lastDoneAt: ago(50), publishedAt: ago(100), firstSessionAt: ago(95) }),
    ).toEqual(ago(50));
    expect(staleAnchor({ lastDoneAt: null, publishedAt: null, firstSessionAt: null })).toBeNull();
    expect(staleRule(game({ publishedAt: null, firstSessionAt: null }), NOW)).toBe('ok');
  });

  it('«all ok» snoozes for 14 days, then reminds/marks again', () => {
    expect(staleRule(game({ deadSnoozedUntil: ahead(1) }), NOW)).toBe('ok');
    expect(staleRule(game({ deadSnoozedUntil: NOW }), NOW)).toBe('dead');
    expect(staleRule(game({ deadSnoozedUntil: ago(1) }), NOW)).toBe('dead');
  });

  it('admin exemption holds until the next done session; only recruiting/started are checked', () => {
    expect(staleRule(game({ deadExemptUntilSession: true }), NOW)).toBe('ok');
    for (const status of ['draft', 'finished', 'cancelled'] as const) {
      expect(staleRule(game({ status }), NOW)).toBe('ok');
    }
    expect(staleRule(game({ status: 'recruiting' }), NOW)).toBe('dead');
  });
});

describe('overlappingGames', () => {
  const s = (gameId: number, startDay: number, hours = 4) => ({
    gameId,
    startsAt: new Date(NOW.getTime() - startDay * DAY),
    durationMinutes: hours * 60,
  });

  it('≥ 3 intersections between two games flag both; 2 do not', () => {
    const three = [s(1, 3), s(2, 3), s(1, 10), s(2, 10), s(1, 17), s(2, 17), s(3, 17)];
    expect([...overlappingGames(three)].sort()).toEqual([1, 2]);
    const two = [s(1, 3), s(2, 3), s(1, 10), s(2, 10), s(1, 17)];
    expect(overlappingGames(two).size).toBe(0);
  });

  it('intervals are half-open: back-to-back sessions do not intersect', () => {
    const adjacent = [0, 7, 14].flatMap((d) => [
      s(1, d),
      {
        gameId: 2,
        startsAt: new Date(NOW.getTime() - d * DAY + 4 * 3_600_000),
        durationMinutes: 60,
      },
    ]);
    expect(overlappingGames(adjacent).size).toBe(0);
    const partial = [0, 7, 14].flatMap((d) => [
      s(1, d),
      {
        gameId: 2,
        startsAt: new Date(NOW.getTime() - d * DAY + 3 * 3_600_000),
        durationMinutes: 60,
      },
    ]);
    expect([...overlappingGames(partial)].sort()).toEqual([1, 2]);
  });

  it('sessions of the same game never count', () => {
    expect(overlappingGames([s(1, 1), s(1, 1), s(1, 1), s(1, 1)]).size).toBe(0);
  });
});
