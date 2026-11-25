import type { UserRole } from '@nri/shared';

/** Ранг ролі: `user < moderator < admin < owner` (як на бекенді). */
export const ROLE_RANK: Record<UserRole, number> = { user: 0, moderator: 1, admin: 2, owner: 3 };

/** Роль не нижча за `min`. */
export function roleAtLeast(role: UserRole | null | undefined, min: UserRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Персонал (модератор і вище) — бачить розділ «Адмінка». */
export function isStaff(role: UserRole | null | undefined): boolean {
  return roleAtLeast(role, 'moderator');
}

/** Можна діяти проти людини лише з нижчою роллю. */
export function canActOn(actor: UserRole | null | undefined, target: UserRole): boolean {
  return !!actor && ROLE_RANK[actor] > ROLE_RANK[target];
}
