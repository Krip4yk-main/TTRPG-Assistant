import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import type { MeDto, ThemeId } from '@nri/shared';
import { AuthStore } from '../core/auth/auth.store';
import { SocketService } from '../core/realtime/socket.service';
import { FALLBACK_SLOTS } from './fallback/fallback-slots';
import type { ThemeSlots } from './slots';
import { THEME_REGISTRY, type ThemeDefinition } from './theme.registry';
import {
  STYLE_WAIT_MS,
  THEME_LINK_ID,
  THEME_STORAGE_KEY,
  THEME_VERSION_STORAGE_KEY,
  ThemeService,
} from './theme.service';

const base = {
  id: 1 as number,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  status: 'active' as const,
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [] as MeDto['identities'],
} satisfies Partial<MeDto>;

const ALL: ThemeId[] = [
  'quest-board',
  'neon-signs',
  'holo-market',
  'night-city',
  'dungeon',
  'gothic-gloom',
];
const user: MeDto = {
  ...base,
  role: 'user',
  uiTheme: 'night-city',
  availableThemes: ALL,
  uiPrefs: { tearAnimation: true },
};

// Окремі «чанки» дизайнів (тест не тягне справжні чанки): «Дошка» і кібер-родина.
const QB_SLOTS = { ...FALLBACK_SLOTS } as ThemeSlots;
const SC_SLOTS = { ...FALLBACK_SLOTS } as ThemeSlots;

function def(id: ThemeId, loadSlots: () => Promise<ThemeSlots>): ThemeDefinition {
  return {
    id,
    labelKey: `theme.names.${id}`,
    preview: `themes/${id}.png`,
    colorScheme: 'dark',
    styleHref: `theme-${id}.css?v=1`,
    loadSlots,
  };
}

/** Як справжній реєстр: дизайни сцени мають один спільний завантажувач слотів. */
function registry(
  load: { qb?: () => Promise<ThemeSlots>; scene?: () => Promise<ThemeSlots> } = {},
): Record<ThemeId, ThemeDefinition> {
  const scene = load.scene ?? (() => Promise.resolve(SC_SLOTS));
  return {
    'quest-board': def('quest-board', load.qb ?? (() => Promise.resolve(QB_SLOTS))),
    'neon-signs': def('neon-signs', scene),
    'holo-market': def('holo-market', scene),
    'night-city': def('night-city', scene),
    dungeon: def('dungeon', scene),
    'gothic-gloom': def('gothic-gloom', scene),
  };
}

/** Дочекатися, доки сервіс підключить `<link>` бандла `href`, і «завантажити» (чи зламати) його. */
async function settleWhenAdded(href: string, type: 'load' | 'error' = 'load'): Promise<void> {
  const find = () =>
    Array.from(document.head.querySelectorAll<HTMLLinkElement>(`link#${THEME_LINK_ID}`)).find(
      (l) => l.getAttribute('href') === href,
    );
  await vi.waitFor(() => expect(find()).toBeTruthy());
  find()!.dispatchEvent(new Event(type));
}

const theme = () => document.documentElement.getAttribute('data-theme');

const links = () =>
  Array.from(document.head.querySelectorAll<HTMLLinkElement>(`link#${THEME_LINK_ID}`)).map((l) =>
    l.getAttribute('href'),
  );

/** Те, що робить інлайн-скрипт index.html з кешу. */
function bootFromCache(id: string, href: string): void {
  localStorage.setItem(THEME_STORAGE_KEY, id);
  document.documentElement.setAttribute('data-theme', id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.id = THEME_LINK_ID;
  link.href = href;
  document.head.appendChild(link);
}

describe('ThemeService', () => {
  let service: ThemeService;
  let auth: AuthStore;

  const setup = (reg = registry()) => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: THEME_REGISTRY, useValue: reg },
        {
          provide: SocketService,
          useValue: { connect: vi.fn(), disconnect: vi.fn(), sessionLost$: new Subject() },
        },
      ],
    });
    service = TestBed.inject(ThemeService);
    auth = TestBed.inject(AuthStore);
  };

  afterEach(() => {
    document.head.querySelectorAll(`link#${THEME_LINK_ID}`).forEach((l) => l.remove());
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('background-color');
    localStorage.clear();
  });

  it('a cached legacy «classic» boots the default design; no classic link is left (RF 1)', async () => {
    setup();
    bootFromCache('classic', 'theme-classic.css?v=1');
    // Навіть якщо /me (підмінений чи старий) повернув classic — він невідомий: дефолт.
    auth.setMe({ ...user, uiTheme: 'classic' as ThemeId });
    await service.init();
    expect(service.theme()).toBe('quest-board');
    expect(document.documentElement.getAttribute('data-theme')).toBe('quest-board');
    expect(links()).toEqual(['theme-quest-board.css?v=1']);
    expect(document.head.querySelector('link[href^="theme-classic"]')).toBeNull();
    expect(service.slots()).toBe(QB_SLOTS);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('quest-board');
    expect(localStorage.getItem(THEME_VERSION_STORAGE_KEY)).toMatch(/^[a-z0-9]+$/);
  });

  it('a guest always gets the default design', async () => {
    setup();
    bootFromCache('night-city', 'theme-night-city.css?v=1');
    auth.setMe(null);
    const done = service.init();
    // Кешований бандл «Нічного міста» стилізує сторінку, доки не завантажився бандл «Дошки».
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    expect(theme()).toBe('night-city');
    await settleWhenAdded('theme-quest-board.css?v=1');
    await done;
    expect(theme()).toBe('quest-board');
    expect(links()).toEqual(['theme-quest-board.css?v=1']);
  });

  it('a regular user keeps «night-city»; the cached link is reused', async () => {
    setup();
    bootFromCache('night-city', 'theme-night-city.css?v=1');
    const cached = document.head.querySelector(`link#${THEME_LINK_ID}`);
    auth.setMe(user);
    await service.init();
    expect(service.theme()).toBe('night-city');
    expect(service.available()).toEqual(ALL);
    expect(service.slots()).toBe(SC_SLOTS);
    expect(document.head.querySelector(`link#${THEME_LINK_ID}`)).toBe(cached);
  });

  it('same design with a stale version swaps the link only after the new one loads', async () => {
    setup();
    bootFromCache('night-city', 'theme-night-city.css?v=old');
    auth.setMe(user);
    await service.init();
    expect(links()).toEqual(['theme-night-city.css?v=old', 'theme-night-city.css?v=1']);
    document.head.querySelectorAll(`link#${THEME_LINK_ID}`)[1]!.dispatchEvent(new Event('load'));
    expect(links()).toEqual(['theme-night-city.css?v=1']);
  });

  it('select() saves the choice and switches data-theme, link and slots without a reload', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    expect(document.documentElement.getAttribute('data-theme')).toBe('night-city');

    const done = service.select('quest-board');
    const req = TestBed.inject(HttpTestingController).expectOne('/api/me/theme');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ theme: 'quest-board' });
    req.flush({ ...user, uiTheme: 'quest-board' });
    await settleWhenAdded('theme-quest-board.css?v=1');
    await done;

    expect(service.theme()).toBe('quest-board');
    expect(document.documentElement.getAttribute('data-theme')).toBe('quest-board');
    expect(links()).toEqual(['theme-quest-board.css?v=1']);
    expect(service.slots()).toBe(QB_SLOTS);
    expect(auth.me()!.uiTheme).toBe('quest-board');
  });

  it('switching between cyber designs swaps data-theme and the bundle link but loads the shared slot chunk once (RF 2)', async () => {
    const scene = vi.fn(() => Promise.resolve(SC_SLOTS));
    setup(registry({ scene }));
    auth.setMe(user);
    await service.init();
    expect(links()).toEqual(['theme-night-city.css?v=1']);

    const done = service.select('neon-signs');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/me/theme')
      .flush({ ...user, uiTheme: 'neon-signs' });
    await settleWhenAdded('theme-neon-signs.css?v=1');
    await done;

    expect(service.theme()).toBe('neon-signs');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon-signs');
    // Старий бандл знято разом із перемиканням — стилі «Нічного міста» не лишаються.
    expect(links()).toEqual(['theme-neon-signs.css?v=1']);
    expect(service.slots()).toBe(SC_SLOTS);
    expect(scene).toHaveBeenCalledTimes(1);
  });

  /** Обрати дизайн (відповідь PATCH — одразу). */
  const choose = (id: ThemeId) => {
    const done = service.select(id);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/me/theme')
      .flush({ ...user, uiTheme: id });
    return done;
  };

  it('a design switch keeps the old data-theme, slots and bundle until the new bundle loads (no unstyled frame)', async () => {
    setup();
    auth.setMe(user);
    await service.init();

    const done = choose('quest-board');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    // Новий бандл ще вантажиться: показано старий дизайн цілком.
    expect(theme()).toBe('night-city');
    expect(service.theme()).toBe('night-city');
    expect(service.slots()).toBe(SC_SLOTS);
    expect(links()).toEqual(['theme-night-city.css?v=1', 'theme-quest-board.css?v=1']);

    await settleWhenAdded('theme-quest-board.css?v=1');
    await done;
    expect(theme()).toBe('quest-board');
    expect(service.slots()).toBe(QB_SLOTS);
    expect(links()).toEqual(['theme-quest-board.css?v=1']);
  });

  it('a new bundle that fails to load still switches the design', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    const done = choose('holo-market');
    await settleWhenAdded('theme-holo-market.css?v=1', 'error');
    await done;
    expect(theme()).toBe('holo-market');
    expect(links()).toEqual(['theme-holo-market.css?v=1']);
  });

  it('a hanging bundle switches the design after the timeout', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = choose('neon-signs');
      // Без vi.waitFor: з фальшивими таймерами він сам просуває час.
      for (let i = 0; i < 50 && links().length < 2; i++) await Promise.resolve();
      expect(links()).toHaveLength(2);
      vi.advanceTimersByTime(STYLE_WAIT_MS - 1);
      expect(theme()).toBe('night-city');
      vi.advanceTimersByTime(1);
      await done;
      expect(theme()).toBe('neon-signs');
      expect(links()).toEqual(['theme-neon-signs.css?v=1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fast A to B to C switch ends on C with only the C bundle (B never applies)', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    const toB = choose('neon-signs');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    const toC = choose('holo-market');
    await vi.waitFor(() => expect(links()).toHaveLength(3));
    // B завантажився першим — але його вже замінив C: лишається старий дизайн.
    await settleWhenAdded('theme-neon-signs.css?v=1');
    await toB;
    expect(theme()).toBe('night-city');
    await settleWhenAdded('theme-holo-market.css?v=1');
    await toC;
    expect(theme()).toBe('holo-market');
    expect(service.theme()).toBe('holo-market');
    expect(links()).toEqual(['theme-holo-market.css?v=1']);
  });

  it('switching back to the shown design before the new bundle loads keeps it and drops the pending bundle', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    void choose('neon-signs');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    await choose('night-city');
    expect(theme()).toBe('night-city');
    expect(links()).toEqual(['theme-night-city.css?v=1']);
  });

  it('logging out returns to the default design', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    auth.setMe(null);
    TestBed.tick();
    await settleWhenAdded('theme-quest-board.css?v=1');
    await vi.waitFor(() => expect(service.theme()).toBe('quest-board'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('quest-board');
  });

  it('a failed design chunk still applies the design and leaves slots to the fallback (RF 3)', async () => {
    setup(registry({ qb: () => Promise.reject(new Error('ChunkLoadError')) }));
    auth.setMe({ ...user, uiTheme: 'quest-board' });
    await expect(service.init()).resolves.toBeUndefined();
    expect(service.slots()).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('quest-board');
    expect(links()).toEqual(['theme-quest-board.css?v=1']);
  });

  it('after a failed chunk the same design retries loading on the next apply', async () => {
    const load = vi
      .fn<() => Promise<ThemeSlots>>()
      .mockRejectedValueOnce(new Error('ChunkLoadError'))
      .mockResolvedValue(QB_SLOTS);
    setup(registry({ qb: load }));
    auth.setMe(user);
    await service.init();
    expect(service.slots()).toBe(SC_SLOTS);

    // Перехід на «Дошку» — чанк не завантажився: резервні слоти.
    let done = service.select('quest-board');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/me/theme')
      .flush({ ...user, uiTheme: 'quest-board' });
    await done;
    expect(service.slots()).toBeNull();

    // Повторний вибір того самого дизайну вантажить чанк знову.
    done = service.select('quest-board');
    TestBed.inject(HttpTestingController)
      .expectOne('/api/me/theme')
      .flush({ ...user, uiTheme: 'quest-board' });
    await done;
    expect(load).toHaveBeenCalledTimes(2);
    expect(service.slots()).toBe(QB_SLOTS);
  });

  it('keeps the early background hint for the same design and drops it when the design changes', async () => {
    setup();
    bootFromCache('quest-board', 'theme-quest-board.css?v=1');
    document.documentElement.style.backgroundColor = 'rgb(58, 39, 24)';
    auth.setMe({ ...user, uiTheme: 'quest-board' });
    await service.init();
    // Кеш збігся з чинним — підказка лишається (бандл дає той самий колір).
    expect(document.documentElement.style.backgroundColor).toBe('rgb(58, 39, 24)');

    auth.setMe(user);
    TestBed.tick();
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    // Ранній фон знімається лише разом із перемиканням (коли новий бандл завантажився).
    expect(document.documentElement.style.backgroundColor).toBe('rgb(58, 39, 24)');
    await settleWhenAdded('theme-night-city.css?v=1');
    await vi.waitFor(() => expect(service.theme()).toBe('night-city'));
    expect(document.documentElement.style.backgroundColor).toBe('');
  });

  it('sets color-scheme on <html> and in <meta name="color-scheme">', async () => {
    const meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark';
    document.head.appendChild(meta);
    const reg = registry();
    reg['quest-board'] = { ...reg['quest-board'], colorScheme: 'light' };
    setup(reg);
    await service.init();
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(meta.content).toBe('light');
    meta.remove();
  });
});
