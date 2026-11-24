import { describe, expect, it } from 'vitest';
import {
  cancelSessionInputSchema,
  finishSessionInputSchema,
  rescheduleSessionInputSchema,
  SESSION_WINDOW_DAYS,
} from './sessions.js';

describe('session contracts', () => {
  it('materializes four weeks ahead', () => {
    expect(SESSION_WINDOW_DAYS).toBe(28);
  });
  it('reschedule normalizes startsAt to UTC ISO and requires whole minutes', () => {
    expect(
      rescheduleSessionInputSchema.parse({ startsAt: '2027-01-04T19:00:00+02:00' }).startsAt,
    ).toBe('2027-01-04T17:00:00.000Z');
    expect(
      rescheduleSessionInputSchema.safeParse({ startsAt: '2027-01-04T19:00:30+02:00' }).success,
    ).toBe(false);
    expect(
      rescheduleSessionInputSchema.safeParse({
        startsAt: '2027-01-04T17:00:00Z',
        durationMinutes: 45,
      }).success,
    ).toBe(false);
  });
  it('cancel requires a reason of at most 300 characters', () => {
    expect(cancelSessionInputSchema.safeParse({ reason: ' ' }).success).toBe(false);
    expect(cancelSessionInputSchema.safeParse({ reason: 'a'.repeat(301) }).success).toBe(false);
    expect(cancelSessionInputSchema.parse({ reason: ' хвороба ' }).reason).toBe('хвороба');
  });
  it('finish takes attendance and an optional summary', () => {
    expect(
      finishSessionInputSchema.parse({ attendance: [{ publicId: 'abcdefghij', present: true }] }),
    ).toEqual({ attendance: [{ publicId: 'abcdefghij', present: true }], summary: null });
    expect(
      finishSessionInputSchema.safeParse({
        attendance: [
          { publicId: 'abcdefghij', present: true },
          { publicId: 'abcdefghij', present: false },
        ],
      }).success,
    ).toBe(false);
  });
});
