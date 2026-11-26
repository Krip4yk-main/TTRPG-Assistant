import type { UserRole } from './me.js';

/**
 * Дизайни сайту, які може обрати користувач (План 8; кібер-дизайни — План 9; інші дизайни сцени —
 * План 10). Невідомий id (напр. прибраний «classic», збережений у БД) дає дизайн за замовчуванням
 * (`resolveTheme`).
 */
export const THEME_IDS = [
  'quest-board',
  'neon-signs',
  'holo-market',
  'night-city',
  'dungeon',
  'gothic-gloom',
  'magicpunk',
  'brass-steam',
  'solar-garden',
  'painted-city',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Дизайн за замовчуванням (і запасний, якщо збережений недоступний ролі). */
export const DEFAULT_THEME: ThemeId = 'quest-board';

/**
 * Дизайни, між якими перемикається гість (не ввійшов) — перемикач у шапці; вибір лише в
 * `localStorage`, без бекенду. Перший — за замовчуванням. Кібер-варіант — один id тут (змінити —
 * один рядок). Після входу діє дизайн акаунта, після виходу — знову вибір гостя.
 */
export const GUEST_THEMES = ['quest-board', 'night-city'] as const satisfies readonly ThemeId[];
export type GuestThemeId = (typeof GUEST_THEMES)[number];

/** Дизайн гостя: збережений id, якщо він серед `GUEST_THEMES`; інакше перший з них. */
export function resolveGuestTheme(stored: string | null): GuestThemeId {
  return GUEST_THEMES.find((t) => t === stored) ?? GUEST_THEMES[0];
}

/** Кому доступний дизайн: усім чи лише власнику платформи. */
export const themeAccess: Record<ThemeId, 'everyone' | 'owner'> = {
  'quest-board': 'everyone',
  'neon-signs': 'everyone',
  'holo-market': 'everyone',
  'night-city': 'everyone',
  dungeon: 'everyone',
  'gothic-gloom': 'everyone',
  magicpunk: 'everyone',
  'brass-steam': 'everyone',
  'solar-garden': 'everyone',
  'painted-city': 'everyone',
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
  /** «Магіпанк»: надіслана заявка складається в конверт, запечатується й відлітає. */
  sendAnimation: boolean;
}

/** Налаштування вигляду для гостя (і до завантаження профілю). */
export const DEFAULT_UI_PREFS: UiPrefsDto = { tearAnimation: true, sendAnimation: true };

/**
 * `PATCH /api/me/ui-prefs` → `MeDto` (схема — `theme-schema.ts`): лише змінені налаштування
 * (хоч одне); решта лишаються як були.
 */
export type UpdateUiPrefsRequest = Partial<UiPrefsDto>;
