import type { RequestHandler } from 'express';
import type { UserRole } from '@nri/shared';
import { AppError } from '../http/errors.js';

export type Role = UserRole;

/** Ієрархія ролей: `user < moderator < admin < owner`. */
export const ROLE_RANK: Record<Role, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };

/**
 * Дії персоналу (матриця дизайну Плану 6):
 * - `complaints.review`, `ratings.moderate`, `sanctions.impose` (крім глобального бану),
 *   `appeals.decide` (апеляції на ці санкції), `games.moderate` («Мертві ігри»: закрити гру чи
 *   зняти позначку, План 7) — модератор+;
 * - `sanctions.ban` (глобальний бан/розбан), `appeals.decide_ban`, `roles.moderator`
 *   (призначити/зняти модератора), `log.view` — адмін+;
 * - `roles.admin` (призначити/зняти адміна), `owner.transfer` — лише власник.
 */
export type StaffAction =
  | 'complaints.review'
  | 'ratings.moderate'
  | 'sanctions.impose'
  | 'sanctions.ban'
  | 'appeals.decide'
  | 'games.moderate'
  | 'appeals.decide_ban'
  | 'roles.moderator'
  | 'roles.admin'
  | 'log.view'
  | 'owner.transfer';

/** Мінімальна роль для кожної дії. */
export const ACTION_MIN_ROLE: Record<StaffAction, Role> = {
  'complaints.review': 'moderator',
  'ratings.moderate': 'moderator',
  'sanctions.impose': 'moderator',
  'appeals.decide': 'moderator',
  'games.moderate': 'moderator',
  'sanctions.ban': 'admin',
  'appeals.decide_ban': 'admin',
  'roles.moderator': 'admin',
  'log.view': 'admin',
  'roles.admin': 'owner',
  'owner.transfer': 'owner',
};

export const STAFF_ACTIONS = Object.keys(ACTION_MIN_ROLE) as StaffAction[];

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function can(role: Role, action: StaffAction): boolean {
  return hasRole(role, ACTION_MIN_ROLE[action]);
}

/** 403 `MODERATION_FORBIDDEN`, якщо роль не має права на дію. */
export function assertCan(role: Role, action: StaffAction): void {
  if (!can(role, action)) throw new AppError(403, 'MODERATION_FORBIDDEN');
}

/**
 * Не можна діяти проти людини з рівною чи вищою роллю (модератор не карає модератора/адміна;
 * адмін — адміна/власника) → 403 `MODERATION_FORBIDDEN`.
 */
export function assertCanActOn(actorRole: Role, targetRole: Role): void {
  if (ROLE_RANK[targetRole] >= ROLE_RANK[actorRole]) {
    throw new AppError(403, 'MODERATION_FORBIDDEN');
  }
}

/**
 * Middleware після `requireAuth`: роль сесії ≥ `min`, інакше 403 `MODERATION_FORBIDDEN`.
 * Роль береться з кешу сесії (зміна ролі скидає кеш сесій користувача — Task 4).
 */
export function requireStaff(min: Exclude<Role, 'user'>): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new AppError(401, 'UNAUTHENTICATED');
    if (!hasRole(req.user.role, min)) throw new AppError(403, 'MODERATION_FORBIDDEN');
    next();
  };
}
