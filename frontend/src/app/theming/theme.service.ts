import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  DEFAULT_THEME,
  DEFAULT_UI_PREFS,
  ME_CHANGED_EVENT,
  THEME_IDS,
  resolveTheme,
  type MeChangedPing,
  type MeDto,
  type ThemeId,
  type UiPrefsDto,
  type UpdateThemeRequest,
  type UpdateUiPrefsRequest,
} from '@nri/shared';
import {
  EMPTY,
  Subject,
  catchError,
  filter,
  firstValueFrom,
  switchMap,
  type Observable,
} from 'rxjs';
import { runtimeConfig } from '../../environments/runtime-config';
import { AuthStore } from '../core/auth/auth.store';
import { SocketService } from '../core/realtime/socket.service';
import type { ThemeSlots } from './slots';
import {
  THEME_REGISTRY,
  type ThemeDefinition,
  type ThemeEffect,
  type ThemeEffectDef,
  type ThemeEffectName,
} from './theme.registry';

/** Кеш останнього чинного дизайну (лише підказка для інлайн-скрипту index.html). */
export const THEME_STORAGE_KEY = 'nri.theme';
/** Версія бандлів стилів, з якою інлайн-скрипт будує `?v=` до старту застосунку. */
export const THEME_VERSION_STORAGE_KEY = 'nri.theme.v';
/** `<link>` бандла стилів дизайну (його ж створює інлайн-скрипт). */
export const THEME_LINK_ID = 'nri-theme-style';
/**
 * Атрибут `<link>` бандла: `load` чи `error`, щойно завантаження скінчилося (ставлять і
 * інлайн-скрипт, і `setStyle`). Без нього не відрізнити бандл, що ще вантажиться, від того, що
 * вже впав: в обох `sheet` порожній, а подій більше не буде.
 */
export const THEME_LINK_SETTLED_ATTR = 'data-settled';
/**
 * Скільки чекати бандл стилів нового дизайну, перш ніж перемкнути дизайн без нього (мережа
 * «зависла»): довше старий дизайн лишатися не повинен.
 */
export const STYLE_WAIT_MS = 3000;
/**
 * Найдовше очікування самого декоративного ефекту (після завантаження чанка): далі викликач іде
 * своїм шляхом, а ефект переривається (`AbortSignal`) і прибирає себе.
 */
export const EFFECT_TIMEOUT_MS = 2500;
/**
 * Найдовше очікування чанка ефекту в мить події: повільніше — ефект пропускається (чанк
 * довантажиться в кеш для наступного разу).
 */
export const EFFECT_LOAD_TIMEOUT_MS = 800;
/**
 * Найдовше очікування шрифту заголовка дизайну (`ThemeDefinition.headingFont`) перед показом
 * дизайну — і при перемиканні (після бандла стилів), і при старті застосунку (разом із бандлом,
 * який підключив інлайн-скрипт). Повільніше — дизайн показується без нього (запасний шрифт).
 */
export const FONT_WAIT_MS = 1000;
/** Текст, за яким довантажуються грані шрифту заголовка: кирилиця й латиниця (цифри). */
const HEADING_FONT_SAMPLE = 'Знайдіть свою гру 0123456789';

/**
 * Чинний дизайн: вибір користувача, якщо він дозволений ролі (`MeDto.uiTheme` уже враховує
 * роль; перевіряємо ще раз), інакше — за замовчуванням; гість — завжди за замовчуванням.
 * Ставить `data-theme` і `color-scheme` на `<html>`, підключає бандл стилів і вантажить слоти.
 * Кеш у `localStorage` — лише підказка: права перевіряються тут, після `/api/me`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly registry = inject(THEME_REGISTRY);
  private readonly auth = inject(AuthStore);
  private readonly http = inject(HttpClient);
  private readonly doc = inject(DOCUMENT);

  private readonly current = signal<ThemeId>(DEFAULT_THEME);
  private readonly loaded = signal<ThemeSlots | null>(null);
  /** Останній запитаний дизайн і обіцянка його застосування. */
  private target: ThemeId | null = null;
  private applying: Promise<void> = Promise.resolve();
  private initialized = false;
  /** Власні PATCH вигляду, що ще тривають (їхня відповідь сама оновить стан). */
  private localWrites = 0;
  /** Лічильник завершених власних PATCH — щоб відкинути `/api/me`, запитаний до них. */
  private localWritesDone = 0;
  /** Пінг прийшов під час власного PATCH — перечитати `/api/me`, коли той завершиться. */
  private deferredRefresh = false;
  private readonly refresh$ = new Subject<void>();
  /**
   * Чанки слотів за завантажувачем: дизайни однієї родини (кібер-дизайни) мають спільний
   * `loadSlots`, тож перемикання між ними не вантажить чанк знову. Невдале завантаження з кешу
   * прибирається — наступний apply пробує ще раз.
   */
  private readonly chunks = new Map<ThemeDefinition['loadSlots'], Promise<ThemeSlots>>();
  /** Чанки ефектів (так само: невдале завантаження прибирається з кешу). */
  private readonly effectChunks = new Map<ThemeEffectDef['load'], Promise<ThemeEffect>>();

  readonly theme = this.current.asReadonly();
  /** Компоненти слотів чинного дизайну; `null` — ще вантажаться або чанк не завантажився. */
  readonly slots = this.loaded.asReadonly();
  /** Дизайни, які користувач може обрати. */
  readonly available = computed<ThemeId[]>(() => {
    const me = this.auth.me();
    return me ? me.availableThemes : [DEFAULT_THEME];
  });

  /** Налаштування вигляду з профілю; гість — за замовчуванням (анімації ввімкнені). */
  readonly uiPrefs = computed<UiPrefsDto>(() => this.auth.me()?.uiPrefs ?? DEFAULT_UI_PREFS);

  private readonly effective = computed<ThemeId>(() => effectiveTheme(this.auth.me()));

  constructor() {
    // Вхід, вихід, зміна ролі чи вибору в іншій вкладці — дизайн іде за станом акаунта.
    effect(() => {
      const id = this.effective();
      if (this.initialized) untracked(() => void this.apply(id));
    });

    // Дизайн чи вигляд змінили в іншій сесії (вкладка, пристрій): пінг без даних — перечитуємо
    // `/api/me`, далі ефект вище застосовує дизайн, а `uiPrefs` оновлюються з профілю.
    inject(SocketService)
      .on<MeChangedPing>(ME_CHANGED_EVENT)
      .pipe(
        filter((p) => p?.scope === 'appearance'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.refresh$.next());
    this.refresh$
      .pipe(
        filter(() => this.auth.isActive()),
        switchMap(() => {
          if (this.localWrites > 0) {
            this.deferredRefresh = true; // власна зміна в дорозі — не боремося з нею
            return EMPTY;
          }
          const since = this.localWritesDone;
          const before = this.auth.me();
          return this.http.get<MeDto>('/api/me').pipe(
            catchError(() => EMPTY), // втрату сесії обробляє AuthStore
            // Відповідь застаріла, якщо тим часом почався чи завершився власний PATCH, стан
            // профілю оновив хтось інший (напр. зміна ніка), або в цій вкладці вже інший акаунт.
            filter(
              (me) =>
                this.localWrites === 0 &&
                since === this.localWritesDone &&
                this.auth.me() === before &&
                me.id === before?.id,
            ),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((me) => {
        if (this.auth.isActive()) this.auth.setMe(me);
      });
  }

  /** Ініціалізатор застосунку (після `AuthStore.load()`): дизайн і слоти — до першого рендера. */
  async init(): Promise<void> {
    this.initialized = true;
    const id = this.effective();
    // Інлайн-скрипт index.html уже підключив бандл цього дизайну: перший рендер — після нього
    // й шрифту заголовка (не довше `FONT_WAIT_MS`), щоб вивіска не малювалась запасним шрифтом.
    const cached = this.themeLinks().find(
      (l) => l.getAttribute('href') === this.registry[id].styleHref,
    );
    if (cached) {
      const ready = this.whenLoaded(cached).then(() => this.headingFont(id));
      await withTimeout(ready, FONT_WAIT_MS);
    }
    return this.apply(id);
  }

  /**
   * Наперед завантажити чанк ефекту чинного дизайну (якщо ефект увімкнений), щоб у мить події
   * він стартував без затримки. Збій завантаження — тихо (повториться в `playEffect`).
   */
  preloadEffect(name: ThemeEffectName): void {
    const def = this.activeEffect(name);
    if (def) this.loadEffect(def).catch(() => undefined);
  }

  /**
   * Програти декоративний ефект чинного дизайну на `source` і дочекатися його кінця. Немає
   * ефекту, вимкнений налаштуванням чи `prefers-reduced-motion: reduce`, чанк не встиг за
   * `EFFECT_LOAD_TIMEOUT_MS` — завершується одразу, `onStart` не викликається. Ніколи не
   * відхиляється: збій ефекту — тихо, довше за `EFFECT_TIMEOUT_MS` — ефект переривається, і
   * викликач іде далі. `onStart` — саме перед стартом ефекту (напр. заборонити закриття).
   */
  async playEffect(
    name: ThemeEffectName,
    source: HTMLElement,
    onStart?: () => void,
  ): Promise<void> {
    const def = this.activeEffect(name);
    if (!def) return;
    try {
      const effect = await withTimeout(this.loadEffect(def), EFFECT_LOAD_TIMEOUT_MS);
      if (!effect) return;
      onStart?.();
      const abort = new AbortController();
      const done = await withTimeout(
        effect(source, abort.signal).then(() => true),
        EFFECT_TIMEOUT_MS,
      );
      if (!done) abort.abort();
    } catch {
      // Ефект декоративний: його збій не заважає основній дії.
    }
  }

  /** Ефект чинного дизайну, якщо він увімкнений (налаштування вигляду, зменшений рух). */
  private activeEffect(name: ThemeEffectName): ThemeEffectDef | null {
    const def = this.registry[this.current()].effects?.[name];
    if (!def) return null;
    if (def.pref && !this.uiPrefs()[def.pref]) return null;
    const media = this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
    return media?.matches ? null : def;
  }

  private loadEffect(def: ThemeEffectDef): Promise<ThemeEffect> {
    let chunk = this.effectChunks.get(def.load);
    if (!chunk) {
      chunk = def.load();
      this.effectChunks.set(def.load, chunk);
      chunk.catch(() => this.effectChunks.delete(def.load));
    }
    return chunk;
  }

  /** Обрати дизайн: зберігає в профілі й застосовує без перезавантаження. */
  async select(id: ThemeId): Promise<void> {
    const body: UpdateThemeRequest = { theme: id };
    const me = await this.write(this.http.patch<MeDto>('/api/me/theme', body));
    await this.apply(effectiveTheme(me));
  }

  /** Зберегти змінені налаштування вигляду в профілі (усі пристрої); решта — як були. */
  async saveUiPrefs(prefs: UpdateUiPrefsRequest): Promise<void> {
    await this.write(this.http.patch<MeDto>('/api/me/ui-prefs', prefs));
  }

  /**
   * Власний PATCH вигляду: поки він триває, пінги `me.changed` (і свій, і чужі) не перечитують
   * `/api/me` — стан оновить його відповідь; пінг, що прийшов тим часом, перечитається після.
   */
  private async write(req: Observable<MeDto>): Promise<MeDto> {
    this.localWrites++;
    try {
      const me = await firstValueFrom(req);
      this.auth.setMe(me);
      return me;
    } finally {
      this.localWrites--;
      this.localWritesDone++;
      if (this.localWrites === 0 && this.deferredRefresh) {
        this.deferredRefresh = false;
        this.refresh$.next();
      }
    }
  }

  private apply(id: ThemeId): Promise<void> {
    if (id === this.target) return this.applying;
    this.target = id;
    this.applying = this.loadSlots(this.registry[id]).then(
      (slots) => this.commit(id, slots),
      // Чанк дизайну не завантажився (мережа): токени й стилі дизайну все одно ставимо,
      // а слоти малюють резервні компоненти — сторінка лишається робочою. `target` скидаємо,
      // щоб наступний apply/select того самого дизайну спробував завантажити чанк знову.
      // Але браузер кешує невдалий динамічний import(): для не-власників реальний повтор — перезавантаження
      // сторінки; скидання допомагає лише при подальшому перемиканні дизайну.
      () =>
        Promise.resolve(this.commit(id, null)).then(() => {
          if (this.target === id) this.target = null;
        }),
    );
    return this.applying;
  }

  private loadSlots(def: ThemeDefinition): Promise<ThemeSlots> {
    let chunk = this.chunks.get(def.loadSlots);
    if (!chunk) {
      chunk = def.loadSlots();
      this.chunks.set(def.loadSlots, chunk);
      chunk.catch(() => this.chunks.delete(def.loadSlots));
    }
    return chunk;
  }

  /**
   * Застосування до DOM — разом зі слотами, щоб дизайн змінювався цілком. Той самий дизайн (чи
   * сторінка ще без стилів дизайну) — одразу. Інший дизайн, коли сторінку вже стилізує бандл
   * попереднього, — лише коли новий бандл завантажився (`load`), упав (`error`) чи минув
   * `STYLE_WAIT_MS`: до того лишаються старі `data-theme`, слоти й бандл, тож між дизайнами
   * немає кадру без стилів. Якщо тим часом обрано інший дизайн — цей не застосовується.
   */
  private commit(id: ThemeId, slots: ThemeSlots | null): Promise<void> | void {
    if (id !== this.target) return; // тим часом обрано інший дизайн
    const href = this.registry[id].styleHref;
    const shown = this.doc.documentElement.getAttribute('data-theme');
    if (shown === id || !this.hasThemeStyles()) {
      this.applyDom(id, slots);
      this.setStyle(href, true);
      return;
    }
    const link = this.setStyle(href, false);
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const apply = () => {
        if (id === this.target) {
          this.applyDom(id, slots);
          this.removeLinksExcept(link);
        }
        resolve();
      };
      // `loaded` — бандл є: спершу (не довше `FONT_WAIT_MS`) шрифт заголовка нового дизайну,
      // інакше вивіска на мить малюється запасним шрифтом. Збій / тайм-аут бандла — одразу.
      const finish = (loaded: boolean) => {
        if (timer === null) return; // уже застосовано (load + error / тайм-аут)
        clearTimeout(timer);
        timer = null;
        if (!loaded || id !== this.target) {
          apply();
          return;
        }
        void withTimeout(this.headingFont(id), FONT_WAIT_MS).then(apply);
      };
      timer = setTimeout(() => finish(false), STYLE_WAIT_MS);
      // Бандл цього дизайну вже підключено (A→B→C→B): завантажений чи впав — одразу; ще
      // вантажиться — чекаємо, як на новий.
      const settled = settledState(link);
      if (settled) {
        finish(settled === 'load');
        return;
      }
      link.addEventListener('load', () => finish(true), { once: true });
      link.addEventListener('error', () => finish(false), { once: true });
    });
  }

  /**
   * Довантажити грані шрифту заголовка дизайну (з уже підключеного бандла). Без
   * `document.fonts` (старий браузер, тести) чи без шрифту в реєстрі — одразу; збій — тихо.
   */
  private async headingFont(id: ThemeId): Promise<void> {
    const font = this.registry[id].headingFont;
    const fonts = this.doc.fonts as FontFaceSet | undefined;
    if (!font || !fonts?.load) return;
    try {
      await fonts.load(font, HEADING_FONT_SAMPLE);
    } catch {
      // Шрифт декоративний: без нього заголовок малюється запасним.
    }
  }

  /**
   * Бандл стилів `link` завантажився (чи впав). Уже завантажений чи впав (`sheet`,
   * `THEME_LINK_SETTLED_ATTR`) — одразу; без `document.fonts` (тести, старий браузер) чекати
   * нема чого — теж одразу.
   */
  private whenLoaded(link: HTMLLinkElement): Promise<void> {
    if (settledState(link) || !(this.doc.fonts as FontFaceSet | undefined)?.load) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
    });
  }

  /** `data-theme`, color-scheme, ранній фон, слоти й підказка в сховищі. */
  private applyDom(id: ThemeId, slots: ThemeSlots | null): void {
    const def = this.registry[id];
    const root = this.doc.documentElement;
    const themeChanged = root.getAttribute('data-theme') !== id;
    root.setAttribute('data-theme', id);
    root.style.colorScheme = def.colorScheme;
    // Ранній фон з інлайн-скрипту index.html — колір дизайну з кешу; інший дизайн — знімаємо:
    // бандл нового дизайну вже завантажено, він малює власний фон.
    if (themeChanged) root.style.removeProperty('background-color');
    this.doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', def.colorScheme);
    this.current.set(id);
    this.loaded.set(slots);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      localStorage.setItem(THEME_VERSION_STORAGE_KEY, runtimeConfig.themeStyleVersion);
    } catch {
      // Сховище недоступне (приватний режим) — лише без підказки для наступного старту.
    }
  }

  private themeLinks(): HTMLLinkElement[] {
    return Array.from(this.doc.head.querySelectorAll<HTMLLinkElement>(`link#${THEME_LINK_ID}`));
  }

  /** Сторінку вже стилізує бандл якогось дизайну з реєстру (є що показувати до перемикання). */
  private hasThemeStyles(): boolean {
    const known = new Set(Object.values(this.registry).map((d) => bundlePath(d.styleHref)));
    return this.themeLinks().some((l) => known.has(bundlePath(l.getAttribute('href'))));
  }

  private removeLinksExcept(keep: HTMLLinkElement): void {
    this.themeLinks().forEach((l) => l !== keep && l.remove());
  }

  /**
   * `<link>` бандла `href`: наявний з тією самою адресою або новий (додається поруч зі
   * старими). Посилання на бандл, якого немає в реєстрі (кеш давно прибраного дизайну, напр.
   * `classic`), знімається одразу. `dropOld` — для дизайну, що вже показаний (та сама тема з
   * іншою версією): старі посилання знімаються, щойно новий бандл завантажився чи впав (а якщо
   * потрібний уже підключено — одразу). Інакше старі лишаються: їх знімає `commit`, коли
   * перемикає `data-theme` на новий дизайн.
   */
  private setStyle(href: string, dropOld: boolean): HTMLLinkElement {
    const known = new Set(Object.values(this.registry).map((d) => bundlePath(d.styleHref)));
    const [stale, old] = partition(
      this.themeLinks(),
      (l) => !known.has(bundlePath(l.getAttribute('href'))),
    );
    stale.forEach((l) => l.remove());
    const same = old.find((l) => l.getAttribute('href') === href);
    if (same) {
      if (dropOld) this.removeLinksExcept(same);
      return same;
    }
    const link = this.doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.id = THEME_LINK_ID;
    const mark = (e: Event) => link.setAttribute(THEME_LINK_SETTLED_ATTR, e.type);
    link.addEventListener('load', mark, { once: true });
    link.addEventListener('error', mark, { once: true });
    if (dropOld && old.length > 0) {
      const drop = () => old.forEach((l) => l.remove());
      link.addEventListener('load', drop, { once: true });
      link.addEventListener('error', drop, { once: true });
    }
    this.doc.head.appendChild(link);
    return link;
  }
}

/** Завантаження бандла `link` скінчилося: `load` (є `sheet`), `error` чи `null` — ще триває. */
function settledState(link: HTMLLinkElement): 'load' | 'error' | null {
  if (link.sheet) return 'load';
  const attr = link.getAttribute(THEME_LINK_SETTLED_ATTR);
  return attr === 'load' || attr === 'error' ? attr : null;
}

/** Результат `promise` або `undefined`, якщо він не встиг за `ms` (помилка — далі). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Адреса бандла без `?v=` (за нею бандл шукається в реєстрі). */
function bundlePath(href: string | null): string {
  return (href ?? '').split('?')[0]!;
}

function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((i) => !test(i))];
}

/** Чинний дизайн для акаунта (гість — за замовчуванням). */
function effectiveTheme(me: MeDto | null): ThemeId {
  if (!me) return DEFAULT_THEME;
  return THEME_IDS.includes(me.uiTheme) ? resolveTheme(me.uiTheme, me.role) : DEFAULT_THEME;
}
