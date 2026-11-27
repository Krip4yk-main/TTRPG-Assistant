import { describe, expect, it } from 'vitest';
import { gameInputSchema, gamePatchSchema, searchFiltersSchema } from './games.js';
import { hasSafetyInfo, safetyListSchema, safetyOverlap, safetyToolsSchema } from './safety.js';

const ok = {
  title: 'Гра',
  systemId: 1,
  genreId: 1,
  format: 'online',
  kind: 'oneshot',
  startsAt: '2027-01-04T17:00:00.000Z',
  durationMinutes: 240,
  minPlayers: 2,
  maxPlayers: 5,
};
const parse = (patch: object) => gameInputSchema('Europe/Kyiv').safeParse({ ...ok, ...patch });

describe('safety contracts', () => {
  it('game safety fields default to empty and the output re-parses', () => {
    const r = parse({});
    expect(r.data).toMatchObject({
      safetyTools: [],
      lines: { warningIds: [], custom: [] },
      veils: { warningIds: [], custom: [] },
    });
    expect(hasSafetyInfo(r.data!)).toBe(false);
    const filled = parse({ safetyTools: ['x_card'], lines: { custom: ['Павуки'] } });
    expect(gameInputSchema('Europe/Kyiv').parse(filled.data)).toEqual(filled.data);
    expect(hasSafetyInfo(filled.data!)).toBe(true);
  });

  it('tools: known ids only, deduplicated in canonical order', () => {
    expect(safetyToolsSchema.parse(['open_door', 'x_card', 'open_door'])).toEqual([
      'x_card',
      'open_door',
    ]);
    expect(safetyToolsSchema.safeParse(['nope']).success).toBe(false);
  });

  it('lists: ids unique and sorted, custom trimmed and unique ignoring case, limits', () => {
    expect(
      safetyListSchema.parse({ warningIds: [3, 1, 3], custom: [' Павуки ', 'ПАВУКИ', 'Голод'] }),
    ).toEqual({ warningIds: [1, 3], custom: ['Павуки', 'Голод'] });
    expect(safetyListSchema.parse({})).toEqual({ warningIds: [], custom: [] });
    expect(safetyListSchema.safeParse({ custom: ['я'.repeat(101)] }).success).toBe(false);
    expect(safetyListSchema.safeParse({ custom: Array(11).fill('x') }).success).toBe(false);
    expect(safetyListSchema.safeParse({ custom: [''] }).success).toBe(false);
    expect(safetyListSchema.safeParse({ warningIds: [0] }).success).toBe(false);
  });

  it('a topic cannot be both a line and a veil', () => {
    expect(parse({ lines: { warningIds: [1] }, veils: { warningIds: [1] } }).success).toBe(false);
    expect(parse({ lines: { custom: ['Павуки'] }, veils: { custom: ['павуки '] } }).success).toBe(
      false,
    );
    expect(parse({ lines: { warningIds: [1] }, veils: { warningIds: [2] } }).success).toBe(true);
    expect(
      safetyOverlap({ warningIds: [1, 2], custom: ['A'] }, { warningIds: [2], custom: ['a', 'b'] }),
    ).toEqual({ warningIds: [2], custom: ['a'] });
  });

  it('patch accepts safety fields; search accepts hasSafetyTools', () => {
    expect(gamePatchSchema.parse({ veils: { custom: ['x'] } }).veils).toEqual({
      warningIds: [],
      custom: ['x'],
    });
    expect(searchFiltersSchema.parse({ hasSafetyTools: true }).hasSafetyTools).toBe(true);
    expect(searchFiltersSchema.safeParse({ hasSafetyTools: 1 }).success).toBe(false);
  });
});
