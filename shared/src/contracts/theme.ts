import type { UserRole } from './me.js';

/** Дизайни сайту, які може обрати користувач (План 8). */
export const THEME_IDS = ['quest-board', 'classic'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Дизайн за замовчуванням (і запасний, якщо збережений недоступний ролі). */
export const DEFAULT_THEME: ThemeId = 'quest-board';

/** Кому доступний дизайн: усім чи лише власнику платформи. */
export const themeAccess: Record<ThemeId, 'everyone' | 'owner'> = {
  'quest-board': 'everyone',
  classic: 'owner',
};

/** Дизайни, доступні ролі. */
export function availableThemes(role: UserRole): ThemeId[] {
  return THEME_IDS.filter((id) => themeAccess[id] === 'everyone' || role === 'owner');
}

/**
 * Ефективний дизайн: збережений id, якщо він відомий і доступний ролі; інакше дефолт.
 * Значення в БД не чіпається (після втрати ролі воно «оживає» при поверненні).
 */
export function resolveTheme(stored: string | null, role: UserRole): ThemeId {
  const id = THEME_IDS.find((t) => t === stored);
  return id && availableThemes(role).includes(id) ? id : DEFAULT_THEME;
}

/** `PATCH /api/me/theme` → `MeDto` (схема — `theme-schema.ts`). */
export interface UpdateThemeRequest {
  theme: ThemeId;
}

/** Налаштування вигляду дизайнів (зберігаються в профілі, `MeDto.uiPrefs`). */
export interface UiPrefsDto {
  /** «Дошка»: оголошення відривається від шпильки перед переходом на сторінку гри. */
  tearAnimation: boolean;
}

/** Налаштування вигляду для гостя (і до завантаження профілю). */
export const DEFAULT_UI_PREFS: UiPrefsDto = { tearAnimation: true };

/** `PATCH /api/me/ui-prefs` → `MeDto` (схема — `theme-schema.ts`). */
export type UpdateUiPrefsRequest = UiPrefsDto;
