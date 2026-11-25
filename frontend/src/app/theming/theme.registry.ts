import { InjectionToken } from '@angular/core';
import type { ThemeId, UiPrefsDto } from '@nri/shared';
import { runtimeConfig } from '../../environments/runtime-config';
import type { ThemeSlots } from './slots';

/** Опис дизайну в реєстрі. */
export interface ThemeDefinition {
  id: ThemeId;
  /** Назва для перемикача (ключ `uk.json`). */
  labelKey: string;
  /** Статична мініатюра для перемикача: `themes/<id>.png` з `public/`. */
  preview: string;
  colorScheme: 'light' | 'dark';
  /** Бандл стилів дизайну з версією збірки: `theme-<бандл>.css?v=<версія>`. */
  styleHref: string;
  /** Лінивий чанк компонентів слотів дизайну. */
  loadSlots: () => Promise<ThemeSlots>;
  /** Власні налаштування дизайну в розділі «Вигляд» (ключі `UiPrefsDto`). */
  options?: (keyof UiPrefsDto)[];
}

/**
 * Адреса бандла стилів (angular.json, `inject: false`). Ім'я бандла Angular не хешує, тож
 * старий кеш після релізу скидає `?v=` — хеш вихідних стилів дизайнів
 * (`scripts/gen-runtime-config.mjs`). Інлайн-скрипт index.html будує ту саму адресу.
 */
export function themeStyleHref(bundle: string): string {
  return `theme-${bundle}.css?v=${runtimeConfig.themeStyleVersion}`;
}

/**
 * Опис дизайну за угодою: назва `theme.names.<id>`, мініатюра `themes/<id>.png`, бандл
 * стилів `theme-<id>`.
 */
function theme(
  id: ThemeId,
  colorScheme: ThemeDefinition['colorScheme'],
  loadSlots: ThemeDefinition['loadSlots'],
  options: ThemeDefinition['options'] = [],
): ThemeDefinition {
  return {
    id,
    labelKey: `theme.names.${id}`,
    preview: `themes/${id}.png`,
    colorScheme,
    styleHref: themeStyleHref(id),
    loadSlots,
    options,
  };
}

/**
 * Усі дизайни. Мапа «дизайн → [бандл, color-scheme, ранній фон]» продубльована в інлайн-скрипті
 * `src/index.html` — змінюйте обидва місця разом.
 */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  // «Дошка оголошень»: дерев'яна стіна, але текст і поля — на пергаменті (чорнило на світлому),
  // тож нативні контроли (select, скролбари панелей, календарі) — світлі.
  // Власне налаштування — анімація відривання оголошення.
  'quest-board': theme(
    'quest-board',
    'light',
    () => import('./themes/quest-board/slots').then((m) => m.QUEST_BOARD_SLOTS),
    ['tearAnimation'],
  ),
  classic: theme('classic', 'dark', () =>
    import('./themes/classic/slots').then((m) => m.CLASSIC_SLOTS),
  ),
};

/** Реєстр дизайнів для DI (у тестах підміняється). */
export const THEME_REGISTRY = new InjectionToken<Record<ThemeId, ThemeDefinition>>(
  'THEME_REGISTRY',
  { providedIn: 'root', factory: () => THEMES },
);
