import { describe, expect, it } from 'vitest';
import { localDate } from './local-date.js';

describe('localDate', () => {
  const d = new Date('2026-11-23T11:00:00Z');
  it('uses the given time zone', () => {
    expect(localDate(d, 'Pacific/Kiritimati')).toBe('2026-11-24');
    expect(localDate(d, 'UTC')).toBe('2026-11-23');
  });
  it('falls back to Europe/Kyiv on invalid or missing zone', () => {
    expect(localDate(new Date('2026-11-23T23:00:00Z'), 'Not/AZone')).toBe('2026-11-24');
    expect(localDate(new Date('2026-11-23T23:00:00Z'), null)).toBe('2026-11-24');
  });
});
