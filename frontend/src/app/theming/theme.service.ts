import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  DEFAULT_THEME,
  DEFAULT_UI_PREFS,
  THEME_IDS,
  resolveTheme,
  type MeDto,
  type ThemeId,
  type UiPrefsDto,
  type UpdateThemeRequest,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { runtimeConfig } from '../../environments/runtime-config';
import { AuthStore } from '../core/auth/auth.store';
import type { ThemeSlots } from './slots';
import { THEME_REGISTRY, type ThemeDefinition } from './theme.registry';

/** Кеш останнього чинного дизайну (лише підказка для інлайн-скрипту index.html). */
export const THEME_STORAGE_KEY = 'nri.theme';
/** Версія бандлів стилів, з якою інлайн-скрипт будує `?v=` до старту застосунку. */
export const THEME_VERSION_STORAGE_KEY = 'nri.theme.v';
/** `<link>` бандла стилів дизайну (його ж створює інлайн-скрипт). */
export const THEME_LINK_ID = 'nri-theme-style';

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
  /**
   * Чанки слотів за завантажувачем: дизайни однієї родини (кібер-дизайни) мають спільний
   * `loadSlots`, тож перемикання між ними не вантажить чанк знову. Невдале завантаження з кешу
   * прибирається — наступний apply пробує ще раз.
   */
  private readonly chunks = new Map<ThemeDefinition['loadSlots'], Promise<ThemeSlots>>();

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
  }

  /** Ініціалізатор застосунку (після `AuthStore.load()`): дизайн і слоти — до першого рендера. */
  init(): Promise<void> {
    this.initialized = true;
    return this.apply(this.effective());
  }

  /** Обрати дизайн: зберігає в профілі й застосовує без перезавантаження. */
  async select(id: ThemeId): Promise<void> {
    const body: UpdateThemeRequest = { theme: id };
    const me = await firstValueFrom(this.http.patch<MeDto>('/api/me/theme', body));
    this.auth.setMe(me);
    await this.apply(effectiveTheme(me));
  }

  /** Зберегти налаштування вигляду в профілі (усі пристрої). */
  async saveUiPrefs(prefs: UiPrefsDto): Promise<void> {
    const me = await firstValueFrom(this.http.patch<MeDto>('/api/me/ui-prefs', prefs));
    this.auth.setMe(me);
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
      () => {
        this.commit(id, null);
        if (this.target === id) this.target = null;
      },
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

  /** Застосування до DOM — разом зі слотами, щоб дизайн змінювався цілком. */
  private commit(id: ThemeId, slots: ThemeSlots | null): void {
    if (id !== this.target) return; // тим часом обрано інший дизайн
    const def = this.registry[id];
    const root = this.doc.documentElement;
    const themeChanged = root.getAttribute('data-theme') !== id;
    root.setAttribute('data-theme', id);
    root.style.colorScheme = def.colorScheme;
    // Ранній фон з інлайн-скрипту index.html — колір дизайну з кешу; інший дизайн — знімаємо,
    // щоб поки вантажиться новий бандл не було видно кольору попереднього.
    if (themeChanged) root.style.removeProperty('background-color');
    this.doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', def.colorScheme);
    this.setStyle(def.styleHref, themeChanged);
    this.current.set(id);
    this.loaded.set(slots);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      localStorage.setItem(THEME_VERSION_STORAGE_KEY, runtimeConfig.themeStyleVersion);
    } catch {
      // Сховище недоступне (приватний режим) — лише без підказки для наступного старту.
    }
  }

  /**
   * Один `<link>` бандла дизайну. Інший дизайн — старий бандл знімається одразу (його
   * селектори вже не збігаються з `data-theme`, і стилі недоступного дизайну не лишаються
   * підключеними). Той самий дизайн з іншою версією — старий знімається після завантаження
   * нового, щоб сторінка не лишилась без стилів.
   */
  private setStyle(href: string, themeChanged: boolean): void {
    const head = this.doc.head;
    const old = Array.from(head.querySelectorAll<HTMLLinkElement>(`link#${THEME_LINK_ID}`));
    if (old.length === 1 && old[0]!.getAttribute('href') === href) return;
    const link = this.doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.id = THEME_LINK_ID;
    if (themeChanged || old.length === 0) {
      old.forEach((l) => l.remove());
    } else {
      const drop = () => old.forEach((l) => l.remove());
      link.addEventListener('load', drop, { once: true });
      link.addEventListener('error', drop, { once: true });
    }
    head.appendChild(link);
  }
}

/** Чинний дизайн для акаунта (гість — за замовчуванням). */
function effectiveTheme(me: MeDto | null): ThemeId {
  if (!me) return DEFAULT_THEME;
  return THEME_IDS.includes(me.uiTheme) ? resolveTheme(me.uiTheme, me.role) : DEFAULT_THEME;
}
