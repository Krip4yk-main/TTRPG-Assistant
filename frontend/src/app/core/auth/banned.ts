import { HttpErrorResponse } from '@angular/common/http';
import type { BannedLoginDetails } from '@nri/shared';

/** 403 `ACCOUNT_BANNED` (вхід заблокованого чи бан посеред сесії). */
export function isAccountBanned(err: unknown): err is HttpErrorResponse {
  return (
    err instanceof HttpErrorResponse &&
    err.status === 403 &&
    (err.error as { error?: { code?: unknown } } | null)?.error?.code === 'ACCOUNT_BANNED'
  );
}

/** `details` помилки `ACCOUNT_BANNED` з токеном апеляції, якщо вони коректні. */
export function bannedDetails(details: unknown): BannedLoginDetails | null {
  const v = details as Partial<BannedLoginDetails> | null | undefined;
  return typeof v?.appealToken === 'string' &&
    v.appealToken !== '' &&
    typeof v.appealSent === 'boolean'
    ? { appealToken: v.appealToken, appealSent: v.appealSent }
    : null;
}

/** `details` з тіла `HttpErrorResponse`. */
export function bannedDetailsOf(err: HttpErrorResponse): BannedLoginDetails | null {
  return bannedDetails((err.error as { error?: { details?: unknown } } | null)?.error?.details);
}
