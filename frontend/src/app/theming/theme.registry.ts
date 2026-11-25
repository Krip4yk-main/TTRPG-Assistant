import { InjectionToken } from '@angular/core';
import type { ThemeId } from '@nri/shared';
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
}

/**
 * Адреса бандла стилів (angular.json, `inject: false`). Ім'я бандла Angular не хешує, тож
 * старий кеш після релізу скидає `?v=` — хеш вихідних стилів дизайнів
 * (`scripts/gen-runtime-config.mjs`). Інлайн-скрипт index.html будує ту саму адресу.
 */
export function themeStyleHref(bundle: string): string {
  return `theme-${bundle}.css?v=${runtimeConfig.themeStyleVersion}`;
}

const loadClassicSlots = (): Promise<ThemeSlots> =>
  import('./themes/classic/slots').then((m) => m.CLASSIC_SLOTS);

/** Усі дизайни. Мапа «дизайн → бандл» продубльована в інлайн-скрипті `src/index.html`. */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  // Тимчасовий аліас: власні слоти, стилі й мініатюру «Дошка оголошень» отримує в задачі 3
  // плану 8; доти вона показує компоненти й бандл «Класичного».
  'quest-board': {
    id: 'quest-board',
    labelKey: 'theme.names.quest-board',
    preview: 'themes/quest-board.png',
    colorScheme: 'dark',
    styleHref: themeStyleHref('classic'),
    loadSlots: loadClassicSlots,
  },
  classic: {
    id: 'classic',
    labelKey: 'theme.names.classic',
    preview: 'themes/classic.png',
    colorScheme: 'dark',
    styleHref: themeStyleHref('classic'),
    loadSlots: loadClassicSlots,
  },
};

/** Реєстр дизайнів для DI (у тестах підміняється). */
export const THEME_REGISTRY = new InjectionToken<Record<ThemeId, ThemeDefinition>>(
  'THEME_REGISTRY',
  { providedIn: 'root', factory: () => THEMES },
);
