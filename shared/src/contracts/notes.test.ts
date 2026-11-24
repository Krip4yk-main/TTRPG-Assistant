import { describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX, noteUpdateSchema } from './notes.js';

describe('noteUpdateSchema', () => {
  it('allows up to 200 000 characters', () => {
    expect(NOTE_BODY_MAX).toBe(200_000);
    expect(noteUpdateSchema.safeParse({ body: 'ї'.repeat(200_000), version: 0 }).success).toBe(
      true,
    );
    expect(noteUpdateSchema.safeParse({ body: 'ї'.repeat(200_001), version: 0 }).success).toBe(
      false,
    );
  });
  it('keeps whitespace and line breaks as typed', () => {
    expect(noteUpdateSchema.parse({ body: ' a\n\n b ', version: 3 }).body).toBe(' a\n\n b ');
  });
  it('requires a non-negative integer version', () => {
    expect(noteUpdateSchema.safeParse({ body: '', version: -1 }).success).toBe(false);
    expect(noteUpdateSchema.safeParse({ body: '', version: 1.5 }).success).toBe(false);
    expect(noteUpdateSchema.safeParse({ body: '' }).success).toBe(false);
  });
});
