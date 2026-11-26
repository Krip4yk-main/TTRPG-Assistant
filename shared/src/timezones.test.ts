import { describe, expect, it } from 'vitest';
import { ianaTimezone } from './schemas/common.js';
import {
  isBlockedTimezone,
  normalizeTimezone,
  safeDefaultTimezone,
  selectableTimezones,
} from './timezones.js';

describe('timezones', () => {
  it('Europe/Kiev → Europe/Kyiv, решта без змін', () => {
    expect(normalizeTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(normalizeTimezone('Europe/Kyiv')).toBe('Europe/Kyiv');
    expect(normalizeTimezone('Europe/Warsaw')).toBe('Europe/Warsaw');
  });

  it('блокує пояси за містами Росії, але не Сімферополь і Мінськ', () => {
    for (const tz of ['Europe/Moscow', 'W-SU', 'Europe/Kaliningrad', 'Asia/Vladivostok']) {
      expect(isBlockedTimezone(tz)).toBe(true);
    }
    for (const tz of ['Europe/Simferopol', 'Europe/Minsk', 'Europe/Kyiv', 'Europe/Kiev']) {
      expect(isBlockedTimezone(tz)).toBe(false);
    }
  });

  it('список для вибору: нормалізований, без заблокованих і дублікатів', () => {
    expect(
      selectableTimezones(['Europe/Kiev', 'Europe/Moscow', 'Europe/Kyiv', 'Europe/Warsaw']),
    ).toEqual(['Europe/Kyiv', 'Europe/Warsaw']);
  });

  it('усі пояси Intl для вибору — без Moscow і Kiev', () => {
    const list = selectableTimezones(Intl.supportedValuesOf('timeZone'));
    expect(list).toContain('Europe/Kyiv');
    expect(list).not.toContain('Europe/Kiev');
    expect(list).not.toContain('Europe/Moscow');
    expect(list).toContain('Europe/Simferopol');
  });

  it('пояс за замовчуванням: заблокований або порожній → Europe/Kyiv', () => {
    expect(safeDefaultTimezone('Europe/Moscow')).toBe('Europe/Kyiv');
    expect(safeDefaultTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(safeDefaultTimezone('')).toBe('Europe/Kyiv');
    expect(safeDefaultTimezone('America/New_York')).toBe('America/New_York');
  });

  it('схема ianaTimezone: Kiev зберігається як Kyiv, заблоковані відхиляються', () => {
    expect(ianaTimezone.parse('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(ianaTimezone.parse('Europe/Simferopol')).toBe('Europe/Simferopol');
    expect(ianaTimezone.safeParse('Europe/Moscow').success).toBe(false);
    expect(ianaTimezone.safeParse('Asia/Kamchatka').success).toBe(false);
    expect(ianaTimezone.safeParse('Not/AZone').success).toBe(false);
  });
});
