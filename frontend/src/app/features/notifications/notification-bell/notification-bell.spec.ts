import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type MeDto, type NotificationDto } from '@nri/shared';
import uk from '../../../../assets/i18n/uk.json';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { ThemeService } from '../../../theming/theme.service';
import { ACCEPTED_NOTICE_STORAGE_KEY } from '../../../theming/moments/accepted-notice';
import { NotificationBell } from './notification-bell';

const testMe: MeDto = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
};

const notification = (id: number, extra: Partial<NotificationDto> = {}): NotificationDto => ({
  id,
  type: 'game.started',
  category: 'games',
  params: { gameId: 7, gameTitle: 'Копальні Морії' },
  link: '/games/7',
  createdAt: '2026-11-25T10:00:00.000Z',
  readAt: null,
  ...extra,
});

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('NotificationBell', () => {
  let fixture: ComponentFixture<NotificationBell>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let events: Map<string, Subject<unknown>>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = () => el.querySelector<HTMLButtonElement>('button.bell')!;
  const badge = () => el.querySelector<HTMLElement>('.mat-badge-content');
  const panel = () => document.querySelector<HTMLElement>('#notifications-panel');

  const start = async (count: number) => {
    fixture = TestBed.createComponent(NotificationBell);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/me/notifications/unread-count').flush({ count });
    await flushAsync();
    await settle();
  };

  const open = async (items: NotificationDto[], nextCursor: number | null = null) => {
    button().click();
    await settle();
    http.expectOne((r) => r.url === '/api/me/notifications').flush({ items, nextCursor });
    await flushAsync();
    await settle();
  };

  beforeEach(async () => {
    events = new Map();
    await TestBed.configureTestingModule({
      imports: [NotificationBell],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'games/:id', children: [] },
          { path: 'my-applications', children: [] },
          { path: 'settings/notifications', children: [] },
        ]),
        provideTranslateService({ fallbackLang: 'uk', lang: 'uk' }),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject(),
            connected$: new Subject(),
            on: (event: string) => {
              if (!events.has(event)) events.set(event, new Subject());
              return events.get(event)!.asObservable();
            },
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).setTranslation('uk', uk);
    TestBed.inject(TranslateService).use('uk');
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthStore).setMe(testMe);
  });

  afterEach(() => {
    fixture?.destroy();
    http.verify();
  });

  it('badge: hidden at 0, aria-label without count', async () => {
    await start(0);
    expect(el.querySelector('.mat-badge-hidden')).not.toBeNull();
    expect(button().getAttribute('aria-label')).toBe(uk.notifications.bell.label);
  });

  it('badge shows the count, capped at 99+, aria-label carries it', async () => {
    await start(7);
    expect(badge()!.textContent!.trim()).toBe('7');
    expect(el.querySelector('.mat-badge-hidden')).toBeNull();
    expect(button().getAttribute('aria-label')).toContain('7');

    events.get(NOTIFICATION_NEW_EVENT)!.next({ id: 1 });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 150 });
    await flushAsync();
    await settle();
    expect(badge()!.textContent!.trim()).toBe('99+');
    expect(button().getAttribute('aria-label')).toContain('99+');
  });

  it('aria-live announces only when the count changes', async () => {
    await start(2);
    const live = el.querySelector<HTMLElement>('[aria-live="polite"]')!;
    expect(live.textContent!.trim()).toBe(''); // початкове значення не оголошується
    events.get(NOTIFICATION_NEW_EVENT)!.next({ id: 1 });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 3 });
    await flushAsync();
    await settle();
    expect(live.textContent).toContain('3');
    const node = live.firstChild;
    await settle();
    expect(live.firstChild).toBe(node); // повторний рендер не змінює вміст
  });

  it('opens the panel, renders texts (actor fallback, thanks) and unread styling', async () => {
    await start(2);
    await open([
      notification(2, {
        type: 'application.created',
        category: 'applications',
        params: { gameId: 7, gameTitle: 'Морія', actor: null },
        link: '/games/7/applications',
      }),
      notification(1, {
        type: 'game.finished',
        params: { gameId: 7, gameTitle: 'Морія', genreSlug: 'horror' },
        readAt: '2026-11-25T11:00:00.000Z',
      }),
    ]);
    expect(button().getAttribute('aria-expanded')).toBe('true');
    const items = panel()!.querySelectorAll<HTMLAnchorElement>('a.item');
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toContain('Нова заявка на гру «Морія».');
    expect(items[0]!.textContent).not.toContain(uk.notifications.someone);
    expect(items[0]!.classList).toContain('unread');
    expect(items[1]!.classList).not.toContain('unread');
    expect(items[1]!.textContent).toContain(uk.notifications.thanks.horror);
    expect(panel()!.textContent).not.toMatch(/notifications\./); // без сирих ключів
  });

  it('renders rating invitations: ratee, deadline line, no line without a deadline', async () => {
    await start(2);
    await open([
      notification(2, {
        type: 'rating.member_left',
        category: 'ratings',
        params: { gameId: 7, gameTitle: 'Морія', ratee: { publicId: 'p', nickname: 'Боромир' } },
        link: '/games/7/rate',
      }),
      notification(1, {
        type: 'rating.deadline',
        category: 'ratings',
        params: {
          gameId: 7,
          gameTitle: 'Морія',
          sessionId: 3,
          closesAt: '2026-12-09T17:00:00.000Z',
        },
        link: '/games/7/rate?session=3',
      }),
    ]);
    const items = panel()!.querySelectorAll<HTMLAnchorElement>('a.item');
    expect(items[0]!.textContent).toContain('Боромир більше не грає в «Морія»');
    expect(items[0]!.textContent).not.toContain('Оцінити можна до');
    expect(items[1]!.textContent).toContain('Оцінити можна до');
    expect(items[1]!.textContent).toContain('19:00');
    // Посилання з query (`?session=`, `?poll=`) не кодують `?` у шлях.
    expect(items[1]!.getAttribute('href')).toBe('/games/7/rate?session=3');
    expect(items[0]!.querySelector('mat-icon')!.textContent).toContain('star');
    expect(panel()!.textContent).not.toMatch(/notifications\.|\{\{/);
  });

  it('clicking an item marks it read, navigates to its link and focuses the page heading', async () => {
    const main = document.createElement('main');
    main.id = 'main-content';
    main.tabIndex = -1;
    main.innerHTML = '<h1>Гра</h1>';
    document.body.appendChild(main);
    await start(1);
    await open([notification(5, { link: '/games/7' })]);
    panel()!.querySelector<HTMLAnchorElement>('a.item')!.click();
    await settle();
    http
      .expectOne('/api/me/notifications/5/read')
      .flush(notification(5, { readAt: '2026-11-25T11:00:00.000Z' }));
    await flushAsync();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/games/7');
    expect(panel()).toBeNull();
    expect(badge()).not.toBeNull();
    expect(el.querySelector('.mat-badge-hidden')).not.toBeNull();
    await flushAsync();
    await settle();
    expect(document.activeElement).toBe(main.querySelector('h1'));
    main.remove();
  });

  it('campaign pause texts; the long-pause reminder has three quick links to the game page', async () => {
    await start(3);
    await open([
      notification(3, {
        type: 'game.long_pause',
        params: { gameId: 7, gameTitle: 'Морія' },
      }),
      notification(2, {
        type: 'game.paused',
        params: { gameId: 7, gameTitle: 'Морія', pauseReason: 'illness', note: 'Застуда' },
      }),
      notification(1, {
        type: 'game.resumed',
        params: {
          gameId: 7,
          gameTitle: 'Морія',
          startsAt: '2026-12-01T17:00:00.000Z',
          recruit: true,
        },
      }),
    ]);
    const items = panel()!.querySelectorAll<HTMLAnchorElement>('a.item');
    expect(items[0]!.textContent).toContain('на паузі вже понад 90 днів');
    expect(items[1]!.textContent).toContain('поставлено на паузу');
    expect(items[1]!.textContent).toContain('Причина: хвороба — Застуда');
    expect(items[2]!.textContent).toContain('оголосив донабір');
    // Час — у поясі глядача (Київ), без назви поясу.
    expect(items[2]!.textContent).toContain('19:00');
    expect(panel()!.textContent).not.toMatch(/notifications\.|games\.|\{\{/);

    const actions = [...panel()!.querySelectorAll<HTMLAnchorElement>('a.item-action')];
    expect(actions.map((a) => [a.textContent!.trim(), a.getAttribute('href')])).toEqual([
      ['Відновити', '/games/7?action=resume'],
      ['Оголосити донабір', '/games/7?action=recruit'],
      ['Завершити кампейн', '/games/7?action=finish'],
    ]);
    // Дії — окремі посилання, не всередині рядка-посилання.
    expect(items[0]!.querySelector('a')).toBeNull();

    actions[1]!.click();
    await settle();
    http.expectOne('/api/me/notifications/3/read').flush(notification(3));
    await flushAsync();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/games/7?action=recruit');
  });

  it('clicking an item for the current page returns focus to the bell', async () => {
    await TestBed.inject(Router).navigateByUrl('/games/7');
    await start(1);
    await open([notification(5, { link: '/games/7' })]);
    panel()!.querySelector<HTMLAnchorElement>('a.item')!.click();
    await settle();
    http.expectOne('/api/me/notifications/5/read').flush(notification(5));
    await flushAsync();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('«Прочитати все» and «Ще»', async () => {
    await start(2);
    await open([notification(3), notification(2)], 2);
    const more = panel()!.querySelector<HTMLButtonElement>('button.load-more')!;
    expect(more.textContent).toContain(uk.notifications.panel.more);
    more.click();
    const req = http.expectOne((r) => r.url === '/api/me/notifications');
    expect(req.request.params.get('cursor')).toBe('2');
    req.flush({ items: [notification(1)], nextCursor: null });
    await flushAsync();
    await settle();
    expect(panel()!.querySelectorAll('a.item').length).toBe(3);
    expect(panel()!.querySelector('button.load-more')).toBeNull();

    panel()!.querySelector<HTMLButtonElement>('button.mark-all')!.click();
    http.expectOne('/api/me/notifications/read-all').flush(null);
    await flushAsync();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 0 });
    await flushAsync();
    await settle();
    expect(panel()!.querySelectorAll('a.item.unread').length).toBe(0);
    expect(el.querySelector('.mat-badge-hidden')).not.toBeNull();
  });

  it('per-item delete button (aria-label) removes the notification and updates the badge', async () => {
    await start(2);
    await open([notification(3), notification(2, { readAt: '2026-11-25T11:00:00.000Z' })], 1);
    const buttons = panel()!.querySelectorAll<HTMLButtonElement>('button.remove');
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.getAttribute('aria-label')).toBe(uk.notifications.panel.remove);
    buttons[0]!.click();
    http
      .expectOne('/api/me/notifications/3')
      .flush(null, { status: 204, statusText: 'No Content' });
    await flushAsync();
    await settle();
    expect(panel()!.querySelectorAll('a.item').length).toBe(1);
  });

  it('«Видалити прочитані» is disabled without read items; confirms before deleting', async () => {
    await start(1);
    await open([notification(3)], 1);
    const btn = () => panel()!.querySelector<HTMLButtonElement>('button.remove-read')!;
    expect(btn().disabled).toBe(true);
    http.expectNone('/api/me/notifications/read');
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    await open([notification(3), notification(2, { readAt: '2026-11-25T11:00:00.000Z' })], 1);
    expect(btn().disabled).toBe(false);
    btn().click();
    await flushAsync();
    await settle();
    const confirm = document.querySelector<HTMLButtonElement>(
      'mat-dialog-actions button.mat-warn, mat-dialog-actions button:last-of-type',
    )!;
    http.expectNone('/api/me/notifications/read');
    confirm.click();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    http.expectOne('/api/me/notifications/read').flush({ deleted: 1 });
    await flushAsync();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 1 });
    await flushAsync();
    http
      .expectOne((r) => r.url === '/api/me/notifications')
      .flush({
        items: [notification(3)],
        nextCursor: null,
      });
    await flushAsync();
    await settle();
    expect(panel()!.querySelectorAll('a.item').length).toBe(1);
  });

  it('empty state and Escape closes', async () => {
    await start(0);
    await open([]);
    expect(panel()!.textContent).toContain(uk.notifications.panel.empty);
    expect(panel()!.querySelector('a[href="/settings/notifications"]')).not.toBeNull();
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(panel()).toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button());
  });

  describe('signature moment acceptedNotice', () => {
    let play: ReturnType<typeof vi.fn>;
    let enabled: ReturnType<typeof vi.fn>;
    const accepted = (id: number, extra: Partial<NotificationDto> = {}) =>
      notification(id, {
        type: 'application.approved',
        category: 'applications',
        params: { gameId: 7, gameTitle: 'Морія' },
        ...extra,
      });
    const reopen = async (items: NotificationDto[]) => {
      button().click(); // закрити
      await settle();
      await open(items);
    };

    /**
     * Розкладка (у jsdom її немає): вікно `.panel-body` — 0…300 px, кожен рядок — 60 px за
     * порядком у списку, зсунутий на `scrolled` (наче прокрутили). Рядок поза 0…300 — не видно.
     */
    let scrolled = 0;
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, height, left: 0, right: 320, width: 320 }) as DOMRect;
    const body = () => panel()!.querySelector<HTMLElement>('.panel-body')!;
    const scrollTo = async (px: number) => {
      scrolled = px;
      body().dispatchEvent(new Event('scroll'));
      await settle();
    };

    beforeEach(() => {
      scrolled = 0;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        if (this.classList.contains('panel-body')) return rect(0, 300);
        if (this.matches('li[data-notification-id]')) {
          const index = [...this.parentElement!.children].indexOf(this);
          return rect(index * 60 - scrolled, 60);
        }
        return rect(0, 0);
      });
      localStorage.removeItem(ACCEPTED_NOTICE_STORAGE_KEY);
      const themes = TestBed.inject(ThemeService);
      play = vi.spyOn(themes, 'playEffect').mockResolvedValue() as unknown as ReturnType<
        typeof vi.fn
      >;
      // Чинний дизайн анімує момент (тест нижче — коли ні).
      enabled = vi.spyOn(themes, 'effectEnabled').mockReturnValue(true) as unknown as ReturnType<
        typeof vi.fn
      >;
    });
    afterEach(() => {
      localStorage.removeItem(ACCEPTED_NOTICE_STORAGE_KEY);
      vi.restoreAllMocks();
    });

    it('first shown unread «вас прийнято» plays once, on its row', async () => {
      await start(2);
      await open([accepted(2), notification(1)]);
      expect(play).toHaveBeenCalledTimes(1);
      const [name, source] = play.mock.calls[0]!;
      expect(name).toBe('acceptedNotice');
      expect(source).toBe(panel()!.querySelector('li[data-notification-id="2"]'));
      expect((source as HTMLElement).textContent).toContain('Морія');

      await reopen([accepted(2), notification(1)]);
      expect(play).toHaveBeenCalledTimes(1);
    });

    it('a newly arrived one (merged into the open panel) plays', async () => {
      await start(1);
      await open([notification(1)]);
      expect(play).not.toHaveBeenCalled();
      events.get(NOTIFICATION_NEW_EVENT)!.next({ id: 3 });
      http.expectOne('/api/me/notifications/unread-count').flush({ count: 2 });
      http
        .expectOne((r) => r.url === '/api/me/notifications')
        .flush({ items: [accepted(3), notification(1)], nextCursor: null });
      await flushAsync();
      await settle();
      expect(play).toHaveBeenCalledTimes(1);
      expect(play.mock.calls[0]![1]).toBe(panel()!.querySelector('li[data-notification-id="3"]'));
    });

    it('read or other notifications — no effect', async () => {
      await start(0);
      await open([
        accepted(2, { readAt: '2026-11-25T11:00:00.000Z' }),
        notification(1, { type: 'application.rejected', category: 'applications' }),
      ]);
      expect(play).not.toHaveBeenCalled();
    });

    it('design without an enabled effect: not claimed, plays later under one that animates', async () => {
      enabled.mockReturnValue(false);
      await start(1);
      await open([accepted(2)]);
      expect(enabled).toHaveBeenCalledWith('acceptedNotice');
      expect(play).not.toHaveBeenCalled();
      expect(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)).toBeNull();

      enabled.mockReturnValue(true);
      await reopen([accepted(2)]);
      expect(play).toHaveBeenCalledTimes(1);
      expect(play.mock.calls[0]![0]).toBe('acceptedNotice');
    });

    it('a row out of view is not claimed; scrolling it into view plays it', async () => {
      const filler = Array.from({ length: 6 }, (_, i) => notification(10 - i));
      await start(1);
      await open([...filler, accepted(2)]); // 7-й рядок: 360…420 px — поза вікном
      expect(play).not.toHaveBeenCalled();
      expect(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)).toBeNull();

      await scrollTo(60); // 300…360 — ще не видно
      expect(play).not.toHaveBeenCalled();
      await scrollTo(150); // 210…270 — видно
      expect(play).toHaveBeenCalledTimes(1);
      expect(play.mock.calls[0]![1]).toBe(panel()!.querySelector('li[data-notification-id="2"]'));
      expect(JSON.parse(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)!)).toEqual([2]);

      await scrollTo(160);
      expect(play).toHaveBeenCalledTimes(1);
    });

    it('only the first visible one is claimed; another plays later', async () => {
      await start(2);
      await open([accepted(3), accepted(2)]);
      expect(play).toHaveBeenCalledTimes(1);
      expect(play.mock.calls[0]![1]).toBe(panel()!.querySelector('li[data-notification-id="3"]'));
      expect(JSON.parse(localStorage.getItem(ACCEPTED_NOTICE_STORAGE_KEY)!)).toEqual([3]);

      await reopen([accepted(3), accepted(2)]);
      expect(play).toHaveBeenCalledTimes(2);
      expect(play.mock.calls[1]![1]).toBe(panel()!.querySelector('li[data-notification-id="2"]'));
    });

    it('closing the panel aborts the running effect', async () => {
      play.mockImplementation(() => new Promise<void>(() => {}));
      await start(1);
      await open([accepted(2)]);
      const cancel = play.mock.calls[0]![3] as AbortSignal;
      expect(cancel.aborted).toBe(false);
      button().click();
      await settle();
      expect(cancel.aborted).toBe(true);
    });

    it('destroying the bell aborts the running effect', async () => {
      play.mockImplementation(() => new Promise<void>(() => {}));
      await start(1);
      await open([accepted(2)]);
      const cancel = play.mock.calls[0]![3] as AbortSignal;
      fixture.destroy();
      expect(cancel.aborted).toBe(true);
    });

    it('already played before a reload (remembered) — no effect', async () => {
      localStorage.setItem(ACCEPTED_NOTICE_STORAGE_KEY, JSON.stringify([2]));
      await start(1);
      await open([accepted(2)]);
      expect(play).not.toHaveBeenCalled();
    });
  });
});
