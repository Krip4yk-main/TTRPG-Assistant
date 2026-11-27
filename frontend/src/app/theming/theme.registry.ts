import { InjectionToken } from '@angular/core';
import type { ThemeId, UiPrefsDto } from '@nri/shared';
import { runtimeConfig } from '../../environments/runtime-config';
import type { ThemeSlots } from './slots';

/**
 * Декоративний ефект дизайну (напр. «Магіпанк» запечатує надіслану заявку в конверт).
 * `source` — елемент, з якого ефект починається (його можна сховати: після ефекту викликач
 * його прибирає). Проміс завершується, коли ефект скінчився і викликач може йти далі (хвіст
 * ефекту — напр. пил, що осідає, — може догорати й після). `signal` спрацьовує, якщо
 * викликач більше не чекає (тайм-аут): ефект має одразу прибрати все своє. `text` — переклад
 * ключа `uk.json` (написи самого ефекту, напр. «Заявку подано» на вивісці).
 */
export type ThemeEffect = (
  source: HTMLElement,
  signal: AbortSignal,
  text: (key: string) => string,
) => Promise<void>;

/**
 * Моменти, на які дизайн може відповісти фірмовою анімацією (кожен дизайн — однією):
 * - `applicationSent` — заявку надіслано (діалог заявки; `source` — поверхня діалогу);
 * - `gameOpened` — гру відкривають кліком по картці (пошук, профіль; `source` — хост картки):
 *   ефект грає на картці, сторінка гри відкривається після нього (картка родини сцени);
 * - `acceptedNotice` — у списку сповіщень уперше показано непрочитане «вас прийнято»
 *   (`application.approved`; `source` — рядок сповіщення; один раз на сповіщення —
 *   `AcceptedNoticeMoment`).
 *
 * Як дизайн реєструє ефект: в описі дизайну (`THEMES` нижче) — `effects: { <момент>:
 * signatureEffect(() => import('./themes/<дизайн>/…').then((m) => m.<ефект>)) }`. Ефект —
 * функція `ThemeEffect`: малює власні елементи (`aria-hidden`, лише CSS/WAAPI, ≤ 3 с — менше
 * за `EFFECT_TIMEOUT_MS`) поверх чи довкола `source`, прибирає їх по завершенні або за
 * `signal`. Чанк ефекту лінивий; перемикач «Фірмові анімації дизайну» (`sendAnimation`)
 * з'являється у «Вигляді» сам.
 * Як ефект програється: місце моменту викликає `ThemeService.preloadEffect(момент)` заздалегідь
 * і `ThemeService.playEffect(момент, source)` у мить події; дизайн без ефекту для моменту,
 * вимкнене налаштування чи `prefers-reduced-motion` — нічого не відбувається (no-op). Ефект
 * лише декор: оголошення LiveAnnouncer про результат дії робить викликач, однаково з ним і без.
 */
export type ThemeEffectName = 'applicationSent' | 'gameOpened' | 'acceptedNotice';

/** Усі моменти (для тестів і перевірок). */
export const THEME_EFFECT_NAMES: readonly ThemeEffectName[] = [
  'applicationSent',
  'gameOpened',
  'acceptedNotice',
];

/** Ефект дизайну в реєстрі. */
export interface ThemeEffectDef {
  /** Налаштування вигляду, що вмикає ефект (`false` — ефекту немає). */
  pref?: keyof UiPrefsDto;
  /** Лінивий чанк ефекту. */
  load: () => Promise<ThemeEffect>;
}

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
  /** Декоративні ефекти дизайну (немає — поведінка звичайна). */
  effects?: Partial<Record<ThemeEffectName, ThemeEffectDef>>;
  /**
   * Шрифт заголовка-вивіски (CSS-скорочення `font` з розміром, напр. `700 1em Jura`): його
   * грані ThemeService довантажує до показу дизайну, щоб заголовок не малювався запасним
   * шрифтом (Chrome інколи лишає запасний гліф в окремому вузлі тексту, як-от «і» вивіски).
   */
  headingFont?: string;
}

/**
 * Фірмова анімація дизайну: вмикається спільним налаштуванням вигляду `sendAnimation` (у UI —
 * «Фірмові анімації дизайну»; назва поля в БД історична).
 */
export function signatureEffect(load: ThemeEffectDef['load']): ThemeEffectDef {
  return { pref: 'sendAnimation', load };
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
 * стилів `theme-<id>`. Налаштування, що вмикають ефекти дизайну, додаються до його власних
 * налаштувань (`options`) самі — перемикач з'являється разом з ефектом.
 */
function theme(
  id: ThemeId,
  colorScheme: ThemeDefinition['colorScheme'],
  headingFont: string,
  loadSlots: ThemeDefinition['loadSlots'],
  options: ThemeDefinition['options'] = [],
  effects: ThemeDefinition['effects'] = {},
): ThemeDefinition {
  return {
    id,
    labelKey: `theme.names.${id}`,
    preview: `themes/${id}.png`,
    colorScheme,
    headingFont,
    styleHref: themeStyleHref(id),
    loadSlots,
    options: [...new Set([...options, ...effectPrefs(effects)])],
    effects,
  };
}

/** Налаштування, що вмикають ефекти (повтори прибирає `theme`). */
function effectPrefs(effects: ThemeDefinition['effects']): (keyof UiPrefsDto)[] {
  return Object.values(effects ?? {}).flatMap((def) => (def?.pref ? [def.pref] : []));
}

/** Слоти родини сцени (спільний лінивий чанк усіх дизайнів сцени). */
const loadSceneSlots = () => import('./themes/scene/slots').then((m) => m.SCENE_SLOTS);

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
    '400 1em Kurale',
    () => import('./themes/quest-board/slots').then((m) => m.QUEST_BOARD_SLOTS),
    ['tearAnimation'],
  ),
  // Родина сцени (themes/scene): окремі дизайни з одним лінивим чанком слотів (той самий
  // import — вантажиться один раз) і власним бандлом стилів кожен. Кібер-дизайни — текст
  // світлий на темному склі.
  // Фірмова анімація «заявку подано»: вивіска запалюється по літерах.
  'neon-signs': theme('neon-signs', 'dark', '700 1em "M PLUS Rounded 1c"', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/neon-signs/sign/application-sent').then((m) => m.lightNeonSign),
    ),
  }),
  // Фірмова анімація «відкриття гри»: картка згортається в проєктор, далі відкривається гра.
  'holo-market': theme('holo-market', 'dark', '700 1em Jura', loadSceneSlots, [], {
    gameOpened: signatureEffect(() =>
      import('./themes/holo-market/projector/game-opened').then((m) => m.foldIntoProjector),
    ),
  }),
  // Фірмова анімація «заявку подано»: рожевий імпульс біжить силовою шиною.
  'night-city': theme('night-city', 'dark', '500 1em Unbounded', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/night-city/bus-pulse/application-sent').then((m) => m.pulseAlongBus),
    ),
  }),
  // Інші дизайни сцени (План 10): той самий чанк слотів, свій бандл стилів.
  // «Підземелля» — фірмова анімація «відкриття гри»: на картці піднімаються ґрати.
  dungeon: theme('dungeon', 'dark', '400 1em "Ruslan Display"', loadSceneSlots, [], {
    gameOpened: signatureEffect(() =>
      import('./themes/dungeon/portcullis/game-opened').then((m) => m.raisePortcullis),
    ),
  }),
  // «Готичний морок» — фірмова анімація «вас прийнято»: на сповіщення лягає сургучна печатка.
  'gothic-gloom': theme('gothic-gloom', 'dark', '600 1em "Cormorant SC"', loadSceneSlots, [], {
    acceptedNotice: signatureEffect(() =>
      import('./themes/gothic-gloom/wax-seal/accepted-notice').then((m) => m.pressWaxSeal),
    ),
  }),
  // «Магіпанк»: надіслана заявка складається в конверт під сургучем і відлітає (фірмова
  // анімація; ефект — окремий лінивий чанк).
  magicpunk: theme('magicpunk', 'dark', '700 1em "Cormorant Unicase"', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/magicpunk/envelope/application-sent').then((m) => m.sendInEnvelope),
    ),
  }),
  // Фірмова анімація «заявку подано»: телеграфна стрічка, штамп і манометр.
  'brass-steam': theme('brass-steam', 'dark', '900 1em "Playfair Display SC"', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/brass-steam/telegraph/application-sent').then((m) => m.printTelegraphTape),
    ),
  }),
  // «Сонячний сад» — світлий дизайн сцени: світла сторінка, поля й оверлеї Material.
  // Фірмова анімація «заявку подано»: з насінини проклюнувся паросток з биркою.
  'solar-garden': theme('solar-garden', 'light', '400 1em Alice', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/solar-garden/sprout/application-sent').then((m) => m.growSprout),
    ),
  }),
  // «Мальоване місто» — темний дизайн сцени (світла лише смуга верхнього міста в заголовку).
  // Фірмова анімація «заявку подано»: пензель виписує тег «Я в грі!».
  'painted-city': theme('painted-city', 'dark', '400 1em "Yeseva One"', loadSceneSlots, [], {
    applicationSent: signatureEffect(() =>
      import('./themes/painted-city/brush-tag/application-sent').then((m) => m.paintBrushTag),
    ),
  }),
};

/** Реєстр дизайнів для DI (у тестах підміняється). */
export const THEME_REGISTRY = new InjectionToken<Record<ThemeId, ThemeDefinition>>(
  'THEME_REGISTRY',
  { providedIn: 'root', factory: () => THEMES },
);
