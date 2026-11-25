import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../errors.js';
import {
  appealDecisionSchema,
  COMPLAINT_REASONS,
  complaintInputSchema,
  complaintsQuerySchema,
  ownerTransferSchema,
  ratingModerationInputSchema,
  roleChangeSchema,
  SANCTION_DURATIONS,
  SANCTION_TYPES,
  sanctionAppealInputSchema,
  sanctionEndsAt,
  sanctionInputSchema,
} from './moderation.js';

const long = 'a'.repeat(2001);

describe('moderation constants', () => {
  it('lists reasons, sanction types and durations from the design', () => {
    expect(COMPLAINT_REASONS).toEqual([
      'scam',
      'harassment',
      'no_show',
      'agreement_violation',
      'inappropriate_content',
      'other',
    ]);
    expect(SANCTION_TYPES).toEqual([
      'warning',
      'application_limit',
      'no_paid_apply',
      'no_paid_create',
      'global_ban',
    ]);
    expect(SANCTION_DURATIONS).toEqual(['7d', '30d', '90d', 'permanent']);
  });

  it('has the moderation error codes', () => {
    for (const code of [
      'MODERATION_FORBIDDEN',
      'COMPLAINT_NOT_ALLOWED',
      'COMPLAINT_RESOLVED',
      'SANCTION_ACTIVE',
      'APPEAL_EXISTS',
      'OWNER_TRANSFER_INVALID',
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('computes the end of a sanction', () => {
    const start = new Date('2026-11-25T10:00:00.000Z');
    expect(sanctionEndsAt(start, '7d')?.toISOString()).toBe('2026-12-02T10:00:00.000Z');
    expect(sanctionEndsAt(start, '30d')?.toISOString()).toBe('2026-12-25T10:00:00.000Z');
    expect(sanctionEndsAt(start, '90d')?.toISOString()).toBe('2027-02-23T10:00:00.000Z');
    expect(sanctionEndsAt(start, 'permanent')).toBeNull();
  });
});

describe('complaintInputSchema', () => {
  it('requires exactly one target', () => {
    expect(complaintInputSchema.safeParse({ targetUserId: 'abc', reason: 'scam' }).success).toBe(
      true,
    );
    expect(complaintInputSchema.safeParse({ targetGameId: 5, reason: 'other' }).success).toBe(true);
    expect(complaintInputSchema.safeParse({ reason: 'scam' }).success).toBe(false);
    expect(
      complaintInputSchema.safeParse({ targetUserId: 'abc', targetGameId: 5, reason: 'scam' })
        .success,
    ).toBe(false);
  });

  it('validates reason, trims the message and limits it to 2000', () => {
    expect(complaintInputSchema.safeParse({ targetGameId: 5, reason: 'spam' }).success).toBe(false);
    expect(complaintInputSchema.parse({ targetGameId: 5, reason: 'scam' }).message).toBe('');
    expect(
      complaintInputSchema.parse({ targetGameId: 5, reason: 'scam', message: '  Текст  ' }).message,
    ).toBe('Текст');
    expect(
      complaintInputSchema.safeParse({ targetGameId: 5, reason: 'scam', message: long }).success,
    ).toBe(false);
    expect(complaintInputSchema.safeParse({ targetGameId: 0, reason: 'scam' }).success).toBe(false);
    expect(
      complaintInputSchema.safeParse({ targetGameId: 5, reason: 'scam', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('sanctionInputSchema', () => {
  it('requires a known type, duration and a non-empty reason ≤ 2000', () => {
    const ok = { type: 'no_paid_apply', duration: '30d', reason: ' Неявки ' };
    expect(sanctionInputSchema.parse(ok)).toEqual({ ...ok, reason: 'Неявки' });
    expect(sanctionInputSchema.safeParse({ ...ok, type: 'mute' }).success).toBe(false);
    expect(sanctionInputSchema.safeParse({ ...ok, duration: '1d' }).success).toBe(false);
    expect(sanctionInputSchema.safeParse({ ...ok, reason: '   ' }).success).toBe(false);
    expect(sanctionInputSchema.safeParse({ ...ok, reason: long }).success).toBe(false);
  });
});

describe('sanctionAppealInputSchema', () => {
  it('requires a non-empty message ≤ 2000', () => {
    expect(sanctionAppealInputSchema.parse({ message: ' Прошу ' })).toEqual({ message: 'Прошу' });
    expect(sanctionAppealInputSchema.safeParse({ message: ' ' }).success).toBe(false);
    expect(sanctionAppealInputSchema.safeParse({ message: long }).success).toBe(false);
  });
});

describe('admin input schemas', () => {
  it('appeal decision: boolean accept, optional note (empty → undefined)', () => {
    expect(appealDecisionSchema.parse({ accept: true, note: '  ' })).toEqual({ accept: true });
    expect(appealDecisionSchema.safeParse({ accept: 'yes' }).success).toBe(false);
  });

  it('rating moderation requires a reason', () => {
    expect(ratingModerationInputSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(ratingModerationInputSchema.safeParse({ reason: 'Образи' }).success).toBe(true);
  });

  it('role change cannot assign owner', () => {
    expect(roleChangeSchema.safeParse({ role: 'moderator' }).success).toBe(true);
    expect(roleChangeSchema.safeParse({ role: 'owner' }).success).toBe(false);
  });

  it('owner transfer requires target and nickname confirmation', () => {
    expect(ownerTransferSchema.safeParse({ toPublicId: 'abc' }).success).toBe(false);
    expect(
      ownerTransferSchema.safeParse({ toPublicId: 'abc', confirmNickname: 'Nick' }).success,
    ).toBe(true);
  });
});

describe('complaintsQuerySchema', () => {
  it('status optional (empty → all), cursor/limit coerced, limit ≤ 50', () => {
    expect(complaintsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(complaintsQuerySchema.parse({ status: '', cursor: '' })).toEqual({ limit: 20 });
    expect(complaintsQuerySchema.parse({ status: 'new', cursor: '7', limit: '50' })).toEqual({
      status: 'new',
      cursor: 7,
      limit: 50,
    });
    expect(complaintsQuerySchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(complaintsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(complaintsQuerySchema.safeParse({ cursor: 'x' }).success).toBe(false);
  });
});
