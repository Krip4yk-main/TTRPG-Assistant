/**
 * Паралельні тести бекенду: кожен воркер vitest (`VITEST_POOL_ID` = 1…TEST_WORKERS) має власну
 * MySQL-БД (`<база>_<id>`), власну Redis-базу й власний ключ адаптера Socket.IO, тож файли
 * тестів не заважають один одному.
 */
export const TEST_WORKERS = 4;

/** `mysql://u:p@h:3306/nri_test?x` → `mysql://u:p@h:3306/nri_test_<id>?x`. */
export function workerDbUrl(baseUrl: string, workerId: number): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}_${workerId}`;
  return url.toString();
}

/** Redis-бази 15, 14, 13, … — нижчі номери лишаються для dev. */
export const workerRedisDb = (workerId: number): number => 16 - workerId;

export function currentWorkerId(): number {
  const id = Number(process.env.VITEST_POOL_ID ?? '1');
  if (!Number.isInteger(id) || id < 1 || id > TEST_WORKERS) {
    throw new Error(`Unexpected VITEST_POOL_ID=${process.env.VITEST_POOL_ID}`);
  }
  return id;
}
