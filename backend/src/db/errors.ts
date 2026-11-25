/** Обхід ланцюжка `cause` (drizzle загортає помилку mysql2) у пошуках коду MySQL. */
function hasMysqlError(err: unknown, code: string, errno: number): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: string; errno?: number };
    if (o.code === code || o.errno === errno) return true;
  }
  return false;
}

/** MySQL ER_DUP_ENTRY (1062): порушення UNIQUE/PRIMARY KEY. */
export const isDuplicateKey = (err: unknown): boolean => hasMysqlError(err, 'ER_DUP_ENTRY', 1062);

/** MySQL ER_NO_REFERENCED_ROW_2 (1452): FK посилається на рядок, якого вже немає. */
export const isMissingReference = (err: unknown): boolean =>
  hasMysqlError(err, 'ER_NO_REFERENCED_ROW_2', 1452);

const TRANSIENT_ERRNOS = new Set([1213, 1205, 1040, 1053, 1317]);
const TRANSIENT_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Тимчасова помилка БД (взаємоблокування 1213, очікування блокування 1205, забагато з'єднань
 * 1040, зупинка сервера 1053, перерваний запит 1317, обрив/відмова з'єднання) — варто
 * повторити пізніше, а не вважати дані «отруйними».
 */
export function isTransientDbError(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const o = e as { code?: unknown; errno?: unknown };
    if (typeof o.errno === 'number' && TRANSIENT_ERRNOS.has(o.errno)) return true;
    if (typeof o.code === 'string' && TRANSIENT_CODES.has(o.code)) return true;
  }
  return false;
}
