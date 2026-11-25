import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AppError, errorHandler } from '../../src/http/errors.js';
import {
  ACTION_MIN_ROLE,
  assertCan,
  assertCanActOn,
  can,
  requireStaff,
  ROLE_RANK,
  STAFF_ACTIONS,
} from '../../src/moderation/permissions.js';
import type { Role, StaffAction } from '../../src/moderation/permissions.js';
import type { SessionUser } from '../../src/auth/session.service.js';

const ROLES: Role[] = ['user', 'moderator', 'admin', 'owner'];

/** Матриця з дизайну Плану 6: дія → [user, moderator, admin, owner]. */
const MATRIX: Record<StaffAction, [boolean, boolean, boolean, boolean]> = {
  'complaints.review': [false, true, true, true],
  'ratings.moderate': [false, true, true, true],
  'sanctions.impose': [false, true, true, true],
  'appeals.decide': [false, true, true, true],
  'games.moderate': [false, true, true, true],
  'sanctions.ban': [false, false, true, true],
  'appeals.decide_ban': [false, false, true, true],
  'roles.moderator': [false, false, true, true],
  'log.view': [false, false, true, true],
  'catalog.edit': [false, false, true, true],
  'roles.admin': [false, false, false, true],
  'owner.transfer': [false, false, false, true],
};

const forbidden = expect.objectContaining({ status: 403, code: 'MODERATION_FORBIDDEN' });

describe('ROLE_RANK', () => {
  it('orders user < moderator < admin < owner', () => {
    expect(ROLE_RANK.user).toBeLessThan(ROLE_RANK.moderator);
    expect(ROLE_RANK.moderator).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
  });
});

describe('can (permission matrix)', () => {
  it('covers exactly the actions of the matrix', () => {
    expect([...STAFF_ACTIONS].sort()).toEqual(Object.keys(MATRIX).sort());
    expect(Object.keys(ACTION_MIN_ROLE).sort()).toEqual(Object.keys(MATRIX).sort());
  });

  const cells = (Object.keys(MATRIX) as StaffAction[]).flatMap((action) =>
    ROLES.map((role, i) => ({ action, role, allowed: MATRIX[action][i]! })),
  );
  it.each(cells)('$role → $action: $allowed', ({ action, role, allowed }) => {
    expect(can(role, action)).toBe(allowed);
    if (allowed) expect(() => assertCan(role, action)).not.toThrow();
    else expect(() => assertCan(role, action)).toThrow(forbidden);
  });
});

describe('assertCanActOn', () => {
  const pairs = ROLES.flatMap((actor) => ROLES.map((target) => ({ actor, target })));
  it.each(pairs)('$actor acting on $target', ({ actor, target }) => {
    const allowed = ROLE_RANK[target] < ROLE_RANK[actor];
    if (allowed) expect(() => assertCanActOn(actor, target)).not.toThrow();
    else expect(() => assertCanActOn(actor, target)).toThrow(forbidden);
  });

  it('throws an AppError with 403 MODERATION_FORBIDDEN on equal or higher roles', () => {
    let err: unknown;
    try {
      assertCanActOn('moderator', 'admin');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 403, code: 'MODERATION_FORBIDDEN' });
    expect(() => assertCanActOn('admin', 'admin')).toThrow(forbidden);
    expect(() => assertCanActOn('admin', 'owner')).toThrow(forbidden);
    expect(() => assertCanActOn('moderator', 'moderator')).toThrow(forbidden);
    expect(() => assertCanActOn('owner', 'admin')).not.toThrow();
    expect(() => assertCanActOn('moderator', 'user')).not.toThrow();
  });
});

describe('requireStaff', () => {
  /** Мінімальний застосунок: роль із заголовка → req.user (без заголовка — анонім). */
  function app(min: Parameters<typeof requireStaff>[0]) {
    const a = express();
    a.use((req, _res, next) => {
      const role = req.header('x-role') as Role | undefined;
      if (role) req.user = { role, userId: 1, sessionId: 1, status: 'active' } as SessionUser;
      next();
    });
    a.get('/staff', requireStaff(min), (_req, res) => {
      res.json({ ok: true });
    });
    a.use(errorHandler);
    return a;
  }

  it('401 without a session', async () => {
    const res = await request(app('moderator')).get('/staff');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  const cases: { min: 'moderator' | 'admin' | 'owner'; role: Role; ok: boolean }[] = (
    ['moderator', 'admin', 'owner'] as const
  ).flatMap((min) => ROLES.map((role) => ({ min, role, ok: ROLE_RANK[role] >= ROLE_RANK[min] })));
  it.each(cases)('min $min, role $role → ok=$ok', async ({ min, role, ok }) => {
    const res = await request(app(min)).get('/staff').set('x-role', role);
    if (ok) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MODERATION_FORBIDDEN');
    }
  });
});
