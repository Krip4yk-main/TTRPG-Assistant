import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import type { MeDto, ThemeId } from '@nri/shared';
import { AuthStore } from '../core/auth/auth.store';
import { SocketService } from '../core/realtime/socket.service';
import { FALLBACK_SLOTS } from './fallback/fallback-slots';
import type { ThemeSlots } from './slots';
import { THEME_REGISTRY, type ThemeDefinition, type ThemeEffect } from './theme.registry';
import {
  EFFECT_LOAD_TIMEOUT_MS,
  EFFECT_TIMEOUT_MS,
  FONT_WAIT_MS,
  GUEST_THEME_STORAGE_KEY,
  STYLE_WAIT_MS,
  THEME_LINK_ID,
  THEME_LINK_SETTLED_ATTR,
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
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [] as MeDto['identities'],
} satisfies Partial<MeDto>;

const ALL: ThemeId[] = [
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
];
const user: MeDto = {
  ...base,
  role: 'user',
  uiTheme: 'night-city',
  availableThemes: ALL,
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
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
    headingFont: `700 1em Head-${id}`,
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
    magicpunk: def('magicpunk', scene),
    'brass-steam': def('brass-steam', scene),
    'solar-garden': def('solar-garden', scene),
    'painted-city': def('painted-city', scene),
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
  let meChanged: Subject<unknown>;

  const setup = (reg = registry()) => {
    meChanged = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: THEME_REGISTRY, useValue: reg },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject(),
            on: (event: string) => (event === 'me.changed' ? meChanged : new Subject()),
          },
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

  it('a guest without a stored choice gets the default design (cached account design is dropped)', async () => {
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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

  it('A to B to C to B while B is still loading waits for the B bundle (no switch to unstyled B)', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    void choose('neon-signs');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    void choose('holo-market');
    await vi.waitFor(() => expect(links()).toHaveLength(3));
    const backToB = choose('neon-signs');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // Бандл B ще вантажиться: лишається старий дизайн.
    expect(theme()).toBe('night-city');
    await settleWhenAdded('theme-neon-signs.css?v=1');
    await backToB;
    expect(theme()).toBe('neon-signs');
    expect(links()).toEqual(['theme-neon-signs.css?v=1']);
  });

  it('A to B to C to B after the B bundle already failed switches at once', async () => {
    setup();
    auth.setMe(user);
    await service.init();
    void choose('neon-signs');
    await vi.waitFor(() => expect(links()).toHaveLength(2));
    void choose('holo-market');
    await vi.waitFor(() => expect(links()).toHaveLength(3));
    await settleWhenAdded('theme-neon-signs.css?v=1', 'error');
    await choose('neon-signs');
    expect(theme()).toBe('neon-signs');
    expect(links()).toEqual(['theme-neon-signs.css?v=1']);
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

  describe('guest design switch (GUEST_THEMES, localStorage only)', () => {
    const http = () => TestBed.inject(HttpTestingController);

    it('a guest may pick only GUEST_THEMES; isGuest is true', async () => {
      setup();
      auth.setMe(null);
      await service.init();
      expect(service.isGuest()).toBe(true);
      expect(service.available()).toEqual(['quest-board', 'night-city']);
    });

    it('select() as a guest stores the choice locally, applies it and makes no request', async () => {
      setup();
      auth.setMe(null);
      await service.init();
      const done = service.select('night-city');
      await settleWhenAdded('theme-night-city.css?v=1');
      await done;
      http().expectNone('/api/me/theme');
      expect(theme()).toBe('night-city');
      expect(service.theme()).toBe('night-city');
      expect(service.slots()).toBe(SC_SLOTS);
      expect(links()).toEqual(['theme-night-city.css?v=1']);
      expect(localStorage.getItem(GUEST_THEME_STORAGE_KEY)).toBe('night-city');
      // Підказка для інлайн-скрипту — теж «Нічне місто» (перезавантаження без мигання).
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('night-city');
    });

    it('a guest cannot pick a design outside GUEST_THEMES', async () => {
      setup();
      auth.setMe(null);
      await service.init();
      await service.select('dungeon');
      http().expectNone('/api/me/theme');
      expect(service.theme()).toBe('quest-board');
      expect(localStorage.getItem(GUEST_THEME_STORAGE_KEY)).toBeNull();
    });

    it('the stored guest choice is applied on start', async () => {
      localStorage.setItem(GUEST_THEME_STORAGE_KEY, 'night-city');
      setup();
      bootFromCache('night-city', 'theme-night-city.css?v=1');
      const cached = document.head.querySelector(`link#${THEME_LINK_ID}`);
      auth.setMe(null);
      await service.init();
      expect(theme()).toBe('night-city');
      expect(service.slots()).toBe(SC_SLOTS);
      expect(document.head.querySelector(`link#${THEME_LINK_ID}`)).toBe(cached);
    });

    it('a stored guest value outside GUEST_THEMES falls back to the default', async () => {
      localStorage.setItem(GUEST_THEME_STORAGE_KEY, 'dungeon');
      setup();
      auth.setMe(null);
      await service.init();
      expect(service.theme()).toBe('quest-board');
    });

    it('login: the account design wins over the guest choice', async () => {
      localStorage.setItem(GUEST_THEME_STORAGE_KEY, 'night-city');
      setup();
      auth.setMe(null);
      await service.init();
      auth.setMe({ ...user, uiTheme: 'holo-market' });
      TestBed.tick();
      await settleWhenAdded('theme-holo-market.css?v=1');
      await vi.waitFor(() => expect(theme()).toBe('holo-market'));
      expect(service.isGuest()).toBe(false);
      // Вибір гостя лишається для наступного виходу.
      expect(localStorage.getItem(GUEST_THEME_STORAGE_KEY)).toBe('night-city');
    });

    it('logout: back to the stored guest choice', async () => {
      localStorage.setItem(GUEST_THEME_STORAGE_KEY, 'night-city');
      setup();
      auth.setMe({ ...user, uiTheme: 'dungeon' });
      await service.init();
      expect(theme()).toBe('dungeon');
      auth.setMe(null);
      TestBed.tick();
      await settleWhenAdded('theme-night-city.css?v=1');
      await vi.waitFor(() => expect(theme()).toBe('night-city'));
    });

    it('a logged-in user still saves select() in the profile (not the guest key)', async () => {
      setup();
      auth.setMe({ ...user, uiTheme: 'quest-board' });
      await service.init();
      const done = service.select('night-city');
      http()
        .expectOne('/api/me/theme')
        .flush({ ...user, uiTheme: 'night-city' });
      await settleWhenAdded('theme-night-city.css?v=1');
      await done;
      expect(localStorage.getItem(GUEST_THEME_STORAGE_KEY)).toBeNull();
    });
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
  describe('heading font (no fallback glyphs in the sign)', () => {
    let fontLoad: ReturnType<typeof vi.fn>;
    let release: () => void;

    /** `document.fonts` браузера (у jsdom його немає): `load` чекає, доки тест не «завантажить». */
    beforeEach(() => {
      fontLoad = vi.fn(
        () =>
          new Promise<FontFace[]>((resolve) => {
            release = () => resolve([]);
          }),
      );
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { load: fontLoad },
      });
    });

    afterEach(() => {
      delete (document as { fonts?: unknown }).fonts;
    });

    it('a switch shows the new design only once its heading font is loaded', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      const done = choose('quest-board');
      await settleWhenAdded('theme-quest-board.css?v=1');
      await vi.waitFor(() =>
        expect(fontLoad).toHaveBeenCalledWith('700 1em Head-quest-board', expect.any(String)),
      );
      // Бандл є, шрифт ще вантажиться: показано старий дизайн цілком.
      expect(theme()).toBe('night-city');
      expect(service.slots()).toBe(SC_SLOTS);
      release();
      await done;
      expect(theme()).toBe('quest-board');
      expect(service.slots()).toBe(QB_SLOTS);
      expect(links()).toEqual(['theme-quest-board.css?v=1']);
    });

    it('a hanging heading font delays the switch by at most FONT_WAIT_MS', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const done = choose('neon-signs');
        for (let i = 0; i < 50 && links().length < 2; i++) await Promise.resolve();
        document.head
          .querySelectorAll(`link#${THEME_LINK_ID}`)[1]!
          .dispatchEvent(new Event('load'));
        await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
        expect(theme()).toBe('night-city');
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(theme()).toBe('neon-signs');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a bundle that failed to load switches at once (no font wait)', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      const done = choose('holo-market');
      await settleWhenAdded('theme-holo-market.css?v=1', 'error');
      await done;
      expect(theme()).toBe('holo-market');
      expect(fontLoad).not.toHaveBeenCalled();
    });

    it('the first render waits for the cached bundle and its heading font', async () => {
      setup();
      bootFromCache('night-city', 'theme-night-city.css?v=1');
      auth.setMe(user);
      let ready = false;
      const init = service.init().then(() => (ready = true));
      await Promise.resolve();
      // Бандл з інлайн-скрипту ще вантажиться — шрифт із нього ще не відомий.
      expect(fontLoad).not.toHaveBeenCalled();
      document.head.querySelector(`link#${THEME_LINK_ID}`)!.dispatchEvent(new Event('load'));
      await vi.waitFor(() =>
        expect(fontLoad).toHaveBeenCalledWith('700 1em Head-night-city', expect.any(String)),
      );
      expect(ready).toBe(false);
      release();
      await init;
      expect(service.theme()).toBe('night-city');
      expect(links()).toEqual(['theme-night-city.css?v=1']);
    });

    it('a cached bundle that already failed before init does not delay the first render', async () => {
      setup();
      bootFromCache('night-city', 'theme-night-city.css?v=1');
      // Інлайн-скрипт позначив кінець завантаження (помилка) ще до старту застосунку.
      document.head
        .querySelector(`link#${THEME_LINK_ID}`)!
        .setAttribute(THEME_LINK_SETTLED_ATTR, 'error');
      fontLoad.mockResolvedValue([]);
      auth.setMe(user);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        let ready = false;
        const init = service.init().then(() => (ready = true));
        for (let i = 0; i < 50 && !ready; i++) await Promise.resolve();
        expect(ready).toBe(true);
        await init;
        expect(service.theme()).toBe('night-city');
      } finally {
        vi.useRealTimers();
      }
    });

    it('the first render never waits longer than FONT_WAIT_MS', async () => {
      setup();
      bootFromCache('night-city', 'theme-night-city.css?v=1');
      auth.setMe(user);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        let ready = false;
        const init = service.init().then(() => (ready = true));
        await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
        expect(ready).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await init;
        expect(service.theme()).toBe('night-city');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('me.changed ping (design changed in another session)', () => {
    const http = () => TestBed.inject(HttpTestingController);

    it('a different server design is applied (data-theme + link) without a PATCH', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      expect(theme()).toBe('night-city');

      meChanged.next({ scope: 'appearance' });
      http()
        .expectOne({ method: 'GET', url: '/api/me' })
        .flush({ ...user, uiTheme: 'dungeon' });
      await settleWhenAdded('theme-dungeon.css?v=1');
      await vi.waitFor(() => expect(theme()).toBe('dungeon'));
      expect(links()).toEqual(['theme-dungeon.css?v=1']);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dungeon');
      http().expectNone('/api/me/theme');
      http().verify();
    });

    it('the same design is a no-op (link untouched)', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      const link = document.head.querySelector(`link#${THEME_LINK_ID}`);

      meChanged.next({ scope: 'appearance' });
      http()
        .expectOne('/api/me')
        .flush({ ...user });
      await Promise.resolve();
      expect(theme()).toBe('night-city');
      expect(document.head.querySelector(`link#${THEME_LINK_ID}`)).toBe(link);
      expect(links()).toEqual(['theme-night-city.css?v=1']);
      http().verify();
    });

    it('updated ui-prefs are applied', async () => {
      setup();
      auth.setMe(user);
      await service.init();
      expect(service.uiPrefs()).toEqual({ tearAnimation: true, sendAnimation: true });

      meChanged.next({ scope: 'appearance' });
      http()
        .expectOne('/api/me')
        .flush({ ...user, uiPrefs: { tearAnimation: false, sendAnimation: true } });
      expect(service.uiPrefs()).toEqual({ tearAnimation: false, sendAnimation: true });
      http().verify();
    });

    it('a ping during an own select() does not refetch until the PATCH settles (no fight)', async () => {
      setup();
      auth.setMe(user);
      await service.init();

      const done = service.select('quest-board');
      const patch = http().expectOne('/api/me/theme');
      meChanged.next({ scope: 'appearance' }); // власний пінг прийшов раніше за відповідь
      http().expectNone({ method: 'GET', url: '/api/me' });
      patch.flush({ ...user, uiTheme: 'quest-board' });
      await settleWhenAdded('theme-quest-board.css?v=1');
      await done;
      expect(theme()).toBe('quest-board');
      // Після PATCH — одне перечитування; те саме значення нічого не змінює.
      http()
        .expectOne('/api/me')
        .flush({ ...user, uiTheme: 'quest-board' });
      await Promise.resolve();
      expect(theme()).toBe('quest-board');
      expect(links()).toEqual(['theme-quest-board.css?v=1']);
      http().verify();
    });

    it('a stale response is dropped when the profile changed meanwhile', async () => {
      setup();
      auth.setMe(user);
      await service.init();

      meChanged.next({ scope: 'appearance' });
      const req = http().expectOne('/api/me');
      auth.setMe({ ...user, nickname: 'Mithrandir' }); // напр. зміна ніка в цій вкладці
      req.flush({ ...user, uiTheme: 'dungeon' });
      await Promise.resolve();
      expect(auth.me()!.nickname).toBe('Mithrandir');
      expect(auth.me()!.uiTheme).toBe('night-city');
      expect(theme()).toBe('night-city');
      http().verify();
    });

    it('a response for another account is not applied', async () => {
      setup();
      auth.setMe(user);
      await service.init();

      meChanged.next({ scope: 'appearance' });
      http()
        .expectOne('/api/me')
        .flush({ ...user, id: 2, nickname: 'Saruman', uiTheme: 'dungeon' });
      await Promise.resolve();
      expect(auth.me()!.id).toBe(1);
      expect(theme()).toBe('night-city');
      http().verify();
    });

    it('guests ignore the ping', async () => {
      setup();
      auth.setMe(null);
      await service.init();
      meChanged.next({ scope: 'appearance' });
      http().expectNone('/api/me');
    });
  });

  describe('decorative effects (applicationSent)', () => {
    /** «Нічне місто» з ефектом за налаштуванням `sendAnimation`. */
    const withEffect = (effect: ThemeEffect, loading?: () => Promise<ThemeEffect>) => {
      const load = vi.fn(loading ?? (() => Promise.resolve(effect)));
      const reg = registry();
      reg['night-city'] = {
        ...reg['night-city'],
        effects: { applicationSent: { pref: 'sendAnimation', load } },
      };
      return { reg, load };
    };
    const start = async (reg: Record<ThemeId, ThemeDefinition>, me: MeDto = user) => {
      setup(reg);
      bootFromCache('night-city', 'theme-night-city.css?v=1');
      auth.setMe(me);
      await service.init();
    };
    const source = () => document.createElement('div');

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('runs the active design effect once on the source and waits for it', async () => {
      let finish!: () => void;
      const effect = vi.fn<ThemeEffect>(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const { reg, load } = withEffect(effect);
      await start(reg);
      const el = source();
      let done = false;
      const onStart = vi.fn(() => expect(effect).not.toHaveBeenCalled());
      const played = service.playEffect('applicationSent', el, onStart).then(() => (done = true));
      await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(effect.mock.calls[0]![0]).toBe(el);
      expect(done).toBe(false);
      finish();
      await played;
      expect(done).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('preloadEffect loads the chunk once; playEffect reuses it', async () => {
      const effect = vi.fn<ThemeEffect>(async () => {});
      const { reg, load } = withEffect(effect);
      await start(reg);
      service.preloadEffect('applicationSent');
      await service.playEffect('applicationSent', source());
      expect(load).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it('a design without the effect resolves at once', async () => {
      await start(registry());
      await expect(service.playEffect('applicationSent', source())).resolves.toBeUndefined();
    });

    it('preference off → no effect (chunk not even loaded)', async () => {
      const effect = vi.fn<ThemeEffect>(async () => {});
      const { reg, load } = withEffect(effect);
      await start(reg, { ...user, uiPrefs: { tearAnimation: true, sendAnimation: false } });
      service.preloadEffect('applicationSent');
      const onStart = vi.fn();
      await service.playEffect('applicationSent', source(), onStart);
      expect(load).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      expect(onStart).not.toHaveBeenCalled();
    });

    it('prefers-reduced-motion: reduce → no effect', async () => {
      const effect = vi.fn<ThemeEffect>(async () => {});
      const { reg, load } = withEffect(effect);
      vi.stubGlobal(
        'matchMedia',
        vi.fn((q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' })),
      );
      await start(reg);
      await service.playEffect('applicationSent', source());
      expect(load).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    });

    it('a failing effect never rejects', async () => {
      const { reg } = withEffect(() => Promise.reject(new Error('boom')));
      await start(reg);
      await expect(service.playEffect('applicationSent', source())).resolves.toBeUndefined();
    });

    it('a hanging effect is aborted after EFFECT_TIMEOUT_MS and the caller goes on', async () => {
      let signal: AbortSignal | undefined;
      const { reg } = withEffect((_el, s) => {
        signal = s;
        return new Promise<void>(() => {});
      });
      await start(reg);
      vi.useFakeTimers();
      let done = false;
      const played = service.playEffect('applicationSent', source()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(EFFECT_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await played;
      expect(done).toBe(true);
      expect(signal?.aborted).toBe(true);
    });

    it('the effect timer starts once the chunk is loaded', async () => {
      let signal: AbortSignal | undefined;
      const hanging: ThemeEffect = (_el, s) => {
        signal = s;
        return new Promise<void>(() => {});
      };
      const loadMs = EFFECT_LOAD_TIMEOUT_MS - 100;
      const { reg } = withEffect(
        hanging,
        () => new Promise((resolve) => setTimeout(() => resolve(hanging), loadMs)),
      );
      await start(reg);
      vi.useFakeTimers();
      let done = false;
      const played = service.playEffect('applicationSent', source()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(loadMs + EFFECT_TIMEOUT_MS - 1);
      expect(signal?.aborted).toBe(false);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await played;
      expect(signal?.aborted).toBe(true);
    });

    it('a chunk slower than EFFECT_LOAD_TIMEOUT_MS skips the effect (no onStart)', async () => {
      const effect = vi.fn<ThemeEffect>(async () => {});
      let release!: (e: ThemeEffect) => void;
      const { reg } = withEffect(
        effect,
        () =>
          new Promise<ThemeEffect>((resolve) => {
            release = resolve;
          }),
      );
      await start(reg);
      vi.useFakeTimers();
      const onStart = vi.fn();
      let done = false;
      const played = service
        .playEffect('applicationSent', source(), onStart)
        .then(() => (done = true));
      await vi.advanceTimersByTimeAsync(EFFECT_LOAD_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await played;
      release(effect);
      await vi.advanceTimersByTimeAsync(0);
      expect(onStart).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
    });
  });
});
