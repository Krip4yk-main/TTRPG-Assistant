import { HttpErrorResponse } from '@angular/common/http';
import { ERROR_CODES, type ErrorCode } from '@nri/shared';

/** Нормалізована помилка API: тіло бекенду `{ error: { code, details? } }`. */
export interface ApiError {
  status: number;
  code: ErrorCode;
  details?: unknown;
}

const KNOWN = new Set<string>(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: { code?: unknown; details?: unknown } } | null;
    const code = body?.error?.code;
    if (isErrorCode(code)) return { status: err.status, code, details: body?.error?.details };
    return { status: err.status, code: err.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL' };
  }
  return { status: 0, code: 'INTERNAL' };
}
