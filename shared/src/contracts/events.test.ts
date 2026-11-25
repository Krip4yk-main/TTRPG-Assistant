import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './events.js';

describe('EVENT_TYPES', () => {
  it('contains the plan 3 domain events', () => {
    for (const t of [
      'application.created',
      'application.approved',
      'application.rejected',
      'application.withdrawn',
      'application.cancelled_age',
      'application.cancelled_game',
      'member.left',
      'member.kicked',
      'member.banned',
      'gm.blacklisted',
      'gm.unblacklisted',
      'session.rescheduled',
      'session.cancelled',
      'session.done',
      'game.converted_to_campaign',
      'game.rule_changed',
      'appeal.created',
      'rating.created',
      'rating.published',
    ])
      expect(EVENT_TYPES).toContain(t);
  });
  it('keeps the existing event types', () => {
    for (const t of ['user.registered', 'game.created', 'game.cancelled', 'user.deleted'])
      expect(EVENT_TYPES).toContain(t);
  });
  it('has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
