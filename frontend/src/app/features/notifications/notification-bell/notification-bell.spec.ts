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
});
