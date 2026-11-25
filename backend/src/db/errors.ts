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
