import { describe, expect, it } from 'vitest';
import {
  cancelSessionInputSchema,
  finishSessionInputSchema,
  rescheduleSessionInputSchema,
  SESSION_SUMMARY_MAX,
  SESSION_WINDOW_DAYS,
  sessionSummaryInputSchema,
  summaryExcerpt,
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
  it('reschedule takes an optional start window (null — exact time, «pin»)', () => {
    const at = '2027-01-04T17:00:00Z';
    expect(rescheduleSessionInputSchema.parse({ startsAt: at }).startWindowMinutes).toBeUndefined();
    expect(
      rescheduleSessionInputSchema.parse({ startsAt: at, startWindowMinutes: null })
        .startWindowMinutes,
    ).toBeNull();
    expect(
      rescheduleSessionInputSchema.parse({ startsAt: at, startWindowMinutes: 90 })
        .startWindowMinutes,
    ).toBe(90);
    for (const bad of [0, 20, 735]) {
      expect(
        rescheduleSessionInputSchema.safeParse({ startsAt: at, startWindowMinutes: bad }).success,
      ).toBe(false);
    }
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

  it('summary input: trimmed, empty → null, limit stays 10 000; finish accepts sendSummary', () => {
    expect(SESSION_SUMMARY_MAX).toBe(10_000);
    expect(sessionSummaryInputSchema.parse({ summary: '  Підсумок ' })).toEqual({
      summary: 'Підсумок',
    });
    expect(sessionSummaryInputSchema.parse({ summary: '   ' })).toEqual({ summary: null });
    expect(sessionSummaryInputSchema.parse({ summary: null })).toEqual({ summary: null });
    expect(sessionSummaryInputSchema.safeParse({ summary: 'x'.repeat(10_001) }).success).toBe(
      false,
    );
    expect(sessionSummaryInputSchema.safeParse({ summary: 'x', extra: 1 }).success).toBe(false);
    expect(
      finishSessionInputSchema.parse({ attendance: [], summary: 'Так', sendSummary: true }),
    ).toEqual({ attendance: [], summary: 'Так', sendSummary: true });
    expect(finishSessionInputSchema.safeParse({ attendance: [], sendSummary: 'yes' }).success).toBe(
      false,
    );
  });

  it('summaryExcerpt: short whole, long cut at a word with «…», emoji not split', () => {
    expect(summaryExcerpt('  Коротко  ')).toBe('Коротко');
    expect(summaryExcerpt('x'.repeat(300))).toBe('x'.repeat(300));
    const long = 'слово '.repeat(100);
    const e = summaryExcerpt(long);
    expect(e.endsWith('слово…')).toBe(true);
    expect([...e].length).toBeLessThanOrEqual(301);
    expect(summaryExcerpt('x'.repeat(400))).toBe(`${'x'.repeat(300)}…`);
    const emoji = summaryExcerpt('🐉'.repeat(301));
    expect(emoji).toBe(`${'🐉'.repeat(300)}…`);
  });
});
