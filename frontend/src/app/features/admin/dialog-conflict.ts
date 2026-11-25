import type { ErrorCode } from '@nri/shared';

/**
 * Діалог дії закрився, бо об'єкт уже змінив хтось інший (409: скаргу розглянуто, апеляцію
 * вирішено, оцінку модеровано, санкцію знято). Сторінка перечитує дані й показує `code`.
 */
export class DialogConflict {
  constructor(readonly code: ErrorCode) {}
}
