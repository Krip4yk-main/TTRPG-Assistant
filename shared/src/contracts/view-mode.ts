/**
 * «Вид гравця / Вид майстра» — які сторінки й навігацію бачить користувач. Окремо від `me.ts`
 * (без zod): фронтенд бере ці значення в початковий бандл.
 */
export const VIEW_MODES = ['player', 'gm'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
/** Вид нової вкладки, якщо користувач не змінив налаштування (і завжди — для гостя). */
export const DEFAULT_VIEW_MODE: ViewMode = 'player';

export function isViewMode(value: unknown): value is ViewMode {
  return VIEW_MODES.includes(value as ViewMode);
}
