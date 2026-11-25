import { SANCTION_TYPES, type SanctionActiveDetails, type SanctionType } from '@nri/shared';
import type { ApiError } from '../api/api-error';

const TYPES = new Set<string>(SANCTION_TYPES);

/** `details` помилки 409 `SANCTION_ACTIVE`, якщо вони коректні; інакше `null`. */
export function sanctionActiveDetails(err: ApiError): SanctionActiveDetails | null {
  if (err.code !== 'SANCTION_ACTIVE') return null;
  const d = err.details as Partial<SanctionActiveDetails> | null | undefined;
  if (typeof d?.type !== 'string' || !TYPES.has(d.type)) return null;
  const endsAt = typeof d.endsAt === 'string' ? d.endsAt : null;
  return { type: d.type as SanctionType, endsAt };
}
