import { HttpErrorResponse } from '@angular/common/http';
import type { BannedLoginDetails, SanctionAppealStatus } from '@nri/shared';

/** 403 `ACCOUNT_BANNED` (вхід заблокованого чи бан посеред сесії). */
export function isAccountBanned(err: unknown): err is HttpErrorResponse {
  return (
    err instanceof HttpErrorResponse &&
    err.status === 403 &&
    (err.error as { error?: { code?: unknown } } | null)?.error?.code === 'ACCOUNT_BANNED'
  );
}

/**
 * Як `SANCTION_APPEAL_STATUSES` зі shared, але без імпорту значення: модуль контрактів тягне
 * zod, а цей файл — у початковому бандлі.
 */
const APPEAL_STATUSES = new Set<string>([
  'pending',
  'accepted',
  'rejected',
] satisfies SanctionAppealStatus[]);

/** Статус апеляції з `details` чи `?appealStatus=` редиректу; невідоме значення — `null`. */
export function appealStatusOf(value: unknown): SanctionAppealStatus | null {
  return typeof value === 'string' && APPEAL_STATUSES.has(value)
    ? (value as SanctionAppealStatus)
    : null;
}

/** `details` помилки `ACCOUNT_BANNED` з токеном апеляції, якщо вони коректні. */
export function bannedDetails(details: unknown): BannedLoginDetails | null {
  const v = details as Partial<BannedLoginDetails> | null | undefined;
  return typeof v?.appealToken === 'string' &&
    v.appealToken !== '' &&
    typeof v.appealSent === 'boolean'
    ? withStatus({ appealToken: v.appealToken, appealSent: v.appealSent }, v.appealStatus)
    : null;
}

/** Додає `appealStatus`, лише якщо він відомий. */
function withStatus(details: BannedLoginDetails, status: unknown): BannedLoginDetails {
  const appealStatus = appealStatusOf(status);
  return appealStatus ? { ...details, appealStatus } : details;
}

/** `details` з тіла `HttpErrorResponse`. */
export function bannedDetailsOf(err: HttpErrorResponse): BannedLoginDetails | null {
  return bannedDetails((err.error as { error?: { details?: unknown } } | null)?.error?.details);
}
