import type { AppealDto, SanctionDto } from '@nri/shared';
import { isMigratedDecision } from '../appeals/appeals';
import { sanctionState } from '../user-card/user-card';
import { assignableRoles } from './roles';

describe('assignableRoles (role matrix)', () => {
  it('a moderator cannot change roles', () => {
    expect(assignableRoles('moderator', 'user')).toEqual([]);
  });

  it('an admin manages moderators only, for people below them', () => {
    expect(assignableRoles('admin', 'user')).toEqual(['user', 'moderator']);
    expect(assignableRoles('admin', 'moderator')).toEqual(['user', 'moderator']);
    expect(assignableRoles('admin', 'admin')).toEqual([]);
    expect(assignableRoles('admin', 'owner')).toEqual([]);
  });

  it('the owner can also appoint and remove admins', () => {
    expect(assignableRoles('owner', 'user')).toEqual(['user', 'moderator', 'admin']);
    expect(assignableRoles('owner', 'admin')).toEqual(['user', 'moderator', 'admin']);
    expect(assignableRoles('owner', 'owner')).toEqual([]);
  });
});

describe('appeal decisions', () => {
  const base = { status: 'rejected', decidedBy: null } as AppealDto;

  it('a decided appeal without a decider was migrated («перенесено»)', () => {
    expect(isMigratedDecision(base)).toBe(true);
    expect(
      isMigratedDecision({ ...base, decidedBy: { publicId: 'x', nickname: 'A', role: 'admin' } }),
    ).toBe(false);
    expect(isMigratedDecision({ ...base, status: 'pending' })).toBe(false);
  });
});

describe('sanctionState', () => {
  const s = {
    active: false,
    endsAt: '2026-11-27T10:00:00.000Z',
    liftedAt: null,
    liftedBy: null,
  } as SanctionDto;

  it('distinguishes active, lifted early and expired', () => {
    expect(sanctionState({ ...s, active: true })).toBe('active');
    expect(sanctionState({ ...s, liftedAt: s.endsAt })).toBe('expired');
    expect(
      sanctionState({
        ...s,
        liftedAt: '2026-11-25T10:00:00.000Z',
        liftedBy: { publicId: 'x', nickname: 'A', role: 'admin' },
      }),
    ).toBe('lifted');
  });
});
