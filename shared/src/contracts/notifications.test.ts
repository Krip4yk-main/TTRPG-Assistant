import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './events.js';
import {
  NOTIFICATION_TYPES,
  defaultNotificationPrefs,
  notificationPrefsInputSchema,
  notificationLink,
  notificationsQuerySchema,
} from './notifications.js';

const telegram = {
  applications: true,
  members: false,
  sessions: true,
  reminders: true,
  games: true,
  ratings: false,
};

describe('notification contracts', () => {
  it('every type except session.reminder and rating.* is a domain event', () => {
    for (const t of NOTIFICATION_TYPES) {
      if (t !== 'session.reminder' && !t.startsWith('rating.')) expect(EVENT_TYPES).toContain(t);
    }
  });

  it('prefs: offsets from the allowed set only, deduped, sorted desc', () => {
    expect(
      notificationPrefsInputSchema.parse({ telegram, reminderOffsets: [60, 1440, 60] }),
    ).toEqual({ telegram, reminderOffsets: [1440, 60] });
    expect(
      notificationPrefsInputSchema.parse({ telegram, reminderOffsets: [] }).reminderOffsets,
    ).toEqual([]);
    for (const bad of [[30], [60.5], ['60'], [15, 60, 180, 1440, 2880, 15]]) {
      expect(
        notificationPrefsInputSchema.safeParse({ telegram, reminderOffsets: bad }).success,
      ).toBe(false);
    }
  });

  it('prefs: strict telegram map with every category', () => {
    const partial: Partial<typeof telegram> = { ...telegram };
    delete partial.games;
    expect(
      notificationPrefsInputSchema.safeParse({ telegram: partial, reminderOffsets: [] }).success,
    ).toBe(false);
    expect(
      notificationPrefsInputSchema.safeParse({
        telegram: { ...telegram, extra: true },
        reminderOffsets: [],
      }).success,
    ).toBe(false);
    expect(
      notificationPrefsInputSchema.safeParse({ telegram, reminderOffsets: [], x: 1 }).success,
    ).toBe(false);
  });

  it('defaults: all telegram categories on, offsets 24h and 1h', () => {
    const d = defaultNotificationPrefs();
    expect(Object.values(d.telegram).every(Boolean)).toBe(true);
    expect(d.reminderOffsets).toEqual([1440, 60]);
    expect(d.telegram.ratings).toBe(true);
  });

  it('query: limit default 20, max 50', () => {
    expect(notificationsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationsQuerySchema.parse({ cursor: '10', limit: '50' })).toEqual({
      cursor: 10,
      limit: 50,
    });
    expect(notificationsQuerySchema.parse({ cursor: '' })).toEqual({ limit: 20 });
    expect(notificationsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(notificationsQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
  });
});

describe('notificationLink', () => {
  it('routes by type', () => {
    expect(notificationLink('application.created', { gameId: 5 })).toBe('/games/5/applications');
    expect(notificationLink('application.rejected', { gameId: 5 })).toBe('/my-applications');
    expect(notificationLink('session.cancelled', { gameId: 5, sessionId: 2 })).toBe('/games/5');
    expect(notificationLink('game.finished', {})).toBe('/');
  });

  it('rating notifications lead to the rate page (session set via ?session=)', () => {
    expect(notificationLink('rating.session_open', { gameId: 5, sessionId: 2 })).toBe(
      '/games/5/rate?session=2',
    );
    expect(notificationLink('rating.deadline', { gameId: 5, sessionId: 2 })).toBe(
      '/games/5/rate?session=2',
    );
    expect(notificationLink('rating.deadline', { gameId: 5 })).toBe('/games/5/rate');
    expect(notificationLink('rating.final_open', { gameId: 5 })).toBe('/games/5/rate');
    expect(notificationLink('rating.member_left', { gameId: 5 })).toBe('/games/5/rate');
  });
});
