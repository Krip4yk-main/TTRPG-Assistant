import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { MatDialog } from '@angular/material/dialog';
import { of, Subject } from 'rxjs';
import type { ApplicationDto, CatalogDto, MeDto, PublicGameDto } from '@nri/shared';
import { GameDetails } from './game-details';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { browserZone } from '../../../core/i18n/dates';
import { ApplyDialog } from '../../applications/apply-dialog/apply-dialog';
import { LeaveDialog } from '../../members/leave-dialog/leave-dialog';
import { ScheduleRuleDialog } from '../../sessions/schedule-rule-dialog/schedule-rule-dialog';
import { ConfirmDialog } from '../../../shared/confirm-dialog/confirm-dialog';
import { PauseDialog } from '../pause/pause-dialog';
import { ResumeDialog } from '../pause/resume-dialog';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Frodo',
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
} satisfies MeDto;

const catalog: CatalogDto = {
  systems: [{ id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 1 }],
  genres: [{ id: 1, slug: 'fantasy' }],
  contentWarnings: [
    { id: 3, slug: 'violence' },
    { id: 4, slug: 'horror' },
  ],
};

const game: PublicGameDto = {
  id: 7,
  title: 'Туман над Дніпром',
  description: 'Детективна кампанія в туманному Києві.',
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'offline',
  city: 'Київ',
  platform: null,
  kind: 'campaign',
  startsAt: '2027-03-02T17:00:00.000Z',
  durationMinutes: 240,
  startWindowMinutes: null,
  recurrence: 'weekly',
  weekdays: [1],
  minPlayers: 3,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  experience: 'beginner',
  language: 'uk',
  requirements: null,
  coverUrl: 'https://example.com/cover.png',
  applicationQuestions: [],
  customWarnings: ['Павуки'],
  contentWarningIds: [3, 4],
  showWhenFull: false,
  timezone: 'Europe/Kyiv',
  status: 'recruiting',
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  nextSessionWindowMinutes: null,
  freeSlots: 2,
  publishedAt: '2026-11-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  pausedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  gmRating: null,
  closedByAdmin: false,
  viewer: { relation: 'none', applicationId: null },
};

const application: ApplicationDto = {
  id: 55,
  gameId: 7,
  status: 'pending',
  message: null,
  answers: [],
  constraints: [],
  cancelReason: null,
  createdAt: '2026-11-25T10:00:00.000Z',
  decidedAt: null,
};

describe('GameDetails', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let pings: Subject<unknown>;
  let socket: { request: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  /** Наступний `dialog.open(...)` закриється з `result`. */
  const nextDialog = (result: unknown) =>
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(result) });

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;

  async function open(
    user: MeDto | null,
    respond: (r: ReturnType<typeof expectGame>) => void,
    url = '/games/7',
  ) {
    // Типово діалог закривається без результату (напр. відкритий з `?action=`).
    dialogOpen = vi.fn(() => ({ afterClosed: () => of(undefined) }));
    pings = new Subject();
    socket = {
      request: vi.fn(() => Promise.resolve({ ok: true, members: true })),
      send: vi.fn(),
    };
    await TestBed.configureTestingModule({
      providers: [
        { provide: MatDialog, useValue: { open: dialogOpen } },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(
          [
            { path: 'games/:id', component: GameDetails },
            { path: '**', children: [] },
          ],
          withComponentInputBinding(),
        ),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: (ev: string) => (ev === 'game.changed' ? pings : new Subject()),
            sessionLost$: new Subject(),
            connected$: new Subject(),
            isConnected: () => false,
            get request() {
              return socket.request;
            },
            get send() {
              return socket.send;
            },
          },
        },
      ],
    });
    TestBed.inject(AuthStore).setMe(user);
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, GameDetails);
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    respond(expectGame());
    await settle();
  }
  const expectGame = () => http.expectOne('/api/games/7');
  /** Учаснику й майстру сторінка підвантажує нотатки й налаштування календаря. */
  const flushNotesAndCalendar = (gm: boolean, autoBusy = true) => {
    http.expectOne('/api/me/settings').flush({ calendarAutoBusy: autoBusy });
    http
      .expectOne('/api/games/7/notes/private')
      .flush({ body: 'Моє приватне', version: 2, updatedAt: '2026-11-20T10:00:00.000Z' });
    if (gm) http.expectNone('/api/games/7/notes/shared');
    else http.expectOne('/api/games/7/notes/shared').flush({ pages: [] });
  };

  const targetsUrl = '/api/games/7/ratings/targets';
  const emptyTargets = {
    gameId: 7,
    gameTitle: 'Туман над Дніпром',
    sessionId: null,
    sessionStartsAt: null,
    kind: 'final',
    targets: [],
  };

  afterEach(() => {
    // Майстру й учасникам сторінка перевіряє, чи є кого оцінити підсумково.
    http.match(targetsUrl).forEach((r) => r.flush(emptyTargets));
    // Панель «Спільний час» (@defer) читає голосування гри — у цих тестах їх немає.
    http.match((r) => /^\/api\/games\/\d+\/polls$/.test(r.url)).forEach((r) => r.flush([]));
    http.verify();
  });

  it('shows full info and warnings as chips', async () => {
    await open(me, (r) => r.flush(game));
    const text = el().textContent!;
    expect(text).toContain('Туман над Дніпром');
    expect(text).toContain('Детективна кампанія');
    expect(text).toContain('D&D 5e');
    expect(text).toContain('Київ');
    expect(el().querySelector<HTMLImageElement>('img.cover')!.alt).toBeTruthy();
    expect(el().querySelectorAll('nri-warning-chip')).toHaveLength(3);
    expect(el().querySelector('a[href="/games/7/edit"]')).toBeNull();
  });

  it('a broken cover URL hides the image instead of leaving a broken one', async () => {
    await open(me, (r) => r.flush(game));
    el().querySelector('img.cover')!.dispatchEvent(new Event('error'));
    await settle();
    expect(el().querySelector('img.cover')).toBeNull();
    expect(el().textContent).toContain('Туман над Дніпром');
  });

  it('a game closed by the administration carries the label; others do not', async () => {
    expect(game.closedByAdmin).toBe(false);
    await open(null, (r) =>
      r.flush({ ...game, status: 'cancelled', cancelledAt: game.updatedAt, closedByAdmin: true }),
    );
    expect(el().querySelector('.badge.closed-by-admin')!.textContent).toContain(
      'games.details.closedByAdmin',
    );
  });

  it('no «closed by the administration» label on a regular game', async () => {
    await open(null, (r) => r.flush(game));
    expect(el().querySelector('.closed-by-admin')).toBeNull();
  });

  describe('live updates', () => {
    const banner = () => document.querySelector<HTMLElement>('nri-update-banner .banner');

    it('watches the game room; a ping for this game shows the banner, refresh reloads and highlights', async () => {
      await open(me, (r) => r.flush(game));
      expect(socket.request).toHaveBeenCalledWith('game.watch', { gameId: 7 });
      expect(banner()).toBeNull();
      // Живий регіон є завжди — поява банера оголошується.
      expect(
        el().parentElement!.querySelector('nri-update-banner [aria-live="polite"]'),
      ).not.toBeNull();

      pings.next({ gameId: 8, scope: 'details' });
      await settle();
      expect(banner()).toBeNull();

      pings.next({ gameId: 7, scope: 'details' });
      await settle();
      expect(banner()!.textContent).toContain('live.updates');
      // Вміст не перечитується сам.
      http.expectNone('/api/games/7');

      banner()!.querySelector<HTMLButtonElement>('button.refresh')!.click();
      await settle();
      expectGame().flush({ ...game, title: 'Новий туман' });
      await settle();
      await settle();
      expect(el().textContent).toContain('Новий туман');
      expect(el().querySelector('header.head')!.classList).toContain('nri-flash');
      expect(banner()).toBeNull();
    });

    it('leaving the page unwatches the room', async () => {
      await open(me, (r) => r.flush(game));
      await harness.navigateByUrl('/elsewhere');
      expect(socket.send).toHaveBeenCalledWith('game.unwatch', { gameId: 7 });
    });

    it('a guest does not watch', async () => {
      await open(null, (r) => r.flush(game));
      expect(socket.request).not.toHaveBeenCalled();
    });
  });

  describe('applying', () => {
    const applyButton = () => el().querySelector<HTMLButtonElement>('button.apply');

    it('apply opens the dialog with the game warnings and questions; success shows "applied"', async () => {
      await open(me, (r) => r.flush({ ...game, applicationQuestions: ['Досвід?'] }));
      expect(applyButton()!.disabled).toBe(false);
      nextDialog({ status: 'applied', application });
      applyButton()!.click();
      await settle();
      expect(dialogOpen).toHaveBeenCalledWith(
        ApplyDialog,
        expect.objectContaining({
          data: {
            gameId: 7,
            title: 'Туман над Дніпром',
            warningSlugs: ['violence', 'horror'],
            customWarnings: ['Павуки'],
            questions: ['Досвід?'],
          },
        }),
      );
      expect(el().querySelector('.relation')!.textContent).toContain('games.details.pending');
      expect(applyButton()).toBeNull();
      expect(el().querySelector('button.withdraw')).not.toBeNull();
      expect(el().querySelector('.notice-area')!.getAttribute('aria-live')).toBe('polite');
    });

    it('success already announced by the dialog effect shows the notice without a second announcement', async () => {
      await open(me, (r) => r.flush(game));
      nextDialog({ status: 'applied', application, announced: true });
      applyButton()!.click();
      await settle();
      const area = el().querySelector('.notice-area')!;
      expect(area.textContent).toContain('games.details.applied');
      expect(area.getAttribute('aria-live')).toBe('off');
    });

    it('cancelled dialog changes nothing', async () => {
      await open(me, (r) => r.flush(game));
      nextDialog(undefined);
      applyButton()!.click();
      await settle();
      expect(applyButton()).not.toBeNull();
    });

    it('409 APPLICATION_EXISTS from the dialog reloads the game and shows "already applied"', async () => {
      await open(me, (r) => r.flush(game));
      nextDialog({ status: 'exists' });
      applyButton()!.click();
      await settle();
      expectGame().flush({ ...game, viewer: { relation: 'pending', applicationId: 55 } });
      await settle();
      expect(el().querySelector('.relation')!.textContent).toContain('games.details.pending');
      expect(applyButton()).toBeNull();
    });

    it('pending: withdraw sends DELETE only after confirmation', async () => {
      await open(me, (r) =>
        r.flush({ ...game, viewer: { relation: 'pending', applicationId: 55 } }),
      );
      const withdraw = () => el().querySelector<HTMLButtonElement>('button.withdraw')!;

      nextDialog(false);
      withdraw().click();
      await settle();
      expect(dialogOpen).toHaveBeenLastCalledWith(ConfirmDialog, expect.anything());
      http.expectNone('/api/applications/55');

      nextDialog(true);
      withdraw().click();
      await settle();
      const req = http.expectOne('/api/applications/55');
      expect(req.request.method).toBe('DELETE');
      req.flush({ ...application, status: 'withdrawn' });
      await settle();
      expect(el().textContent).toContain('games.details.withdrawn');
      expect(applyButton()!.disabled).toBe(false);
    });

    it('member sees the "You are a member" badge instead of apply', async () => {
      await open(me, (r) =>
        r.flush({ ...game, viewer: { relation: 'member', applicationId: null } }),
      );
      expect(el().querySelector('.relation')!.textContent).toContain('games.details.member');
      expect(applyButton()).toBeNull();
      // Учасник бачить склад гри (без меню керування), сесії й свою заявку.
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      http.expectOne('/api/me/applications').flush([]);
      flushNotesAndCalendar(false);
      await settle();
      expect(el().querySelector('nri-sessions-list')).not.toBeNull();
      expect(el().querySelector('nri-members-panel')).not.toBeNull();
      expect(el().querySelector('button.member-menu')).toBeNull();
    });

    for (const relation of ['banned', 'blacklisted'] as const) {
      it(`${relation}: apply is disabled with an explanation`, async () => {
        await open(me, (r) => r.flush({ ...game, viewer: { relation, applicationId: null } }));
        expect(applyButton()!.disabled).toBe(true);
        const hintId = applyButton()!.getAttribute('aria-describedby')!;
        expect(el().querySelector(`#${hintId}`)!.textContent).toContain(
          `games.details.${relation}Hint`,
        );
      });
    }

    it('a game that does not accept applications: disabled with an explanation', async () => {
      await open(me, (r) => r.flush({ ...game, status: 'finished' }));
      expect(applyButton()!.disabled).toBe(true);
      const hintId = applyButton()!.getAttribute('aria-describedby')!;
      expect(el().querySelector(`#${hintId}`)!.textContent).toContain('games.details.closedHint');
    });

    it('guest gets a login link that returns to the game', async () => {
      const guestView: PublicGameDto = { ...game };
      delete guestView.viewer;
      await open(null, (r) => r.flush(guestView));
      expect(applyButton()).toBeNull();
      const link = el().querySelector<HTMLAnchorElement>('a.apply-login')!;
      expect(decodeURIComponent(link.getAttribute('href')!)).toContain('/login?returnTo=/games/7');
    });
  });

  it('the GM sees "Edit" instead of "Apply"', async () => {
    await open(me, (r) => r.flush({ ...game, gm: { ...game.gm, publicId: me.publicId } }));
    expect(el().querySelector('a[href="/games/7/edit"]')).not.toBeNull();
    expect(el().querySelector('button.apply')).toBeNull();
    expect(el().querySelector('a[href="/games/7/applications"]')).not.toBeNull();
    http
      .expectOne('/api/games/7/members')
      .flush([
        { publicId: 'pppppppppp', nickname: 'Sam', avatarUrl: null, joinedAt: game.createdAt },
      ]);
    http.expectOne('/api/games/7/sessions').flush([]);
    flushNotesAndCalendar(true);
    await settle();
    expect(el().querySelector('[data-member-id="pppppppppp"] button.member-menu')).not.toBeNull();
    // Майстер не подає заявок — власні заявки не запитуються; кнопки виходу немає.
    http.expectNone('/api/me/applications');
    expect(el().querySelector('button.leave')).toBeNull();
  });

  describe('members and the GM', () => {
    const asMember = { ...game, viewer: { relation: 'member', applicationId: null } } as const;
    const flushMemberExtras = async (applications: unknown[] = []) => {
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      http.expectOne('/api/me/applications').flush(applications);
      flushNotesAndCalendar(false);
      await settle();
    };

    it('a member sees the GM answers to their constraints', async () => {
      await open(me, (r) => r.flush(asMember));
      await flushMemberExtras([
        {
          ...application,
          id: 50,
          status: 'rejected',
          constraints: [{ id: 'x', text: 'Старе', response: null, comment: null }],
        },
        {
          ...application,
          status: 'approved',
          constraints: [
            { id: 'aaaaaaaa', text: 'Без павуків', response: 'partial', comment: 'Лише згадки' },
            { id: 'bbbbbbbb', text: 'До 22:00', response: null, comment: null },
          ],
        },
        { ...application, id: 60, gameId: 8, status: 'approved' },
      ]);
      const block = el().querySelector<HTMLElement>('.my-constraints')!;
      expect(block.textContent).toContain('Без павуків');
      expect(block.textContent).toContain('games.applications.constraintResponse.partial');
      expect(block.textContent).toContain('Лише згадки');
      expect(block.textContent).toContain('games.applications.constraintResponse.none');
      expect(block.textContent).not.toContain('Старе');
    });

    it('leave opens the dialog; after leaving the game reloads with a notice', async () => {
      await open(me, (r) => r.flush(asMember));
      await flushMemberExtras();
      nextDialog(undefined);
      el().querySelector<HTMLButtonElement>('button.leave')!.click();
      await settle();
      expect(dialogOpen).toHaveBeenCalledWith(
        LeaveDialog,
        expect.objectContaining({ data: { gameId: 7, title: game.title } }),
      );
      http.expectNone('/api/games/7');

      nextDialog(true);
      el().querySelector<HTMLButtonElement>('button.leave')!.click();
      await settle();
      expectGame().flush(game);
      await settle();
      await settle();
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.details.left');
      expect(el().querySelector('nri-sessions-list')).toBeNull();
      expect(document.activeElement).toBe(el().querySelector('.notice-area'));
    });

    it('after leaving, «Rate members» appears without a page reload', async () => {
      await open(me, (r) => r.flush(asMember));
      await flushMemberExtras();
      http.expectOne(targetsUrl).flush(emptyTargets);
      await settle();
      expect(el().querySelector('a.rate-members-link')).toBeNull();

      nextDialog(true);
      el().querySelector<HTMLButtonElement>('button.leave')!.click();
      await settle();
      expectGame().flush({
        ...game,
        viewer: { relation: 'none', applicationId: null, wasMember: true },
      });
      await settle();
      http.expectOne(targetsUrl).flush({
        ...emptyTargets,
        targets: [
          {
            publicId: 'gggggggggg',
            nickname: 'Gandalf',
            avatarUrl: null,
            role: 'gm',
            state: 'open',
            closesAt: null,
          },
        ],
      });
      await settle();
      expect(el().querySelector('a.rate-members-link')!.getAttribute('href')).toBe('/games/7/rate');
    });

    it('a member sees the private and the shared notes', async () => {
      await open(me, (r) => r.flush(asMember));
      await flushMemberExtras();
      const notes = el().querySelector<HTMLElement>('.notes')!;
      expect(notes.querySelector<HTMLTextAreaElement>('nri-note-editor textarea')!.value).toBe(
        'Моє приватне',
      );
      expect(notes.querySelector('nri-shared-player-notes')).not.toBeNull();
    });

    it('the GM does not see the shared players note', async () => {
      await open(me, (r) => r.flush({ ...game, gm: { ...game.gm, publicId: me.publicId } }));
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      flushNotesAndCalendar(true);
      await settle();
      expect(el().querySelector('.notes nri-note-editor')).not.toBeNull();
      expect(el().querySelector('nri-shared-player-notes')).toBeNull();
    });

    it('manual calendar mode: «add to my calendar» toggle pins the game', async () => {
      await open(me, (r) => r.flush(asMember));
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      http.expectOne('/api/me/applications').flush([]);
      flushNotesAndCalendar(false, false);
      await settle();
      http.expectOne('/api/me/calendar/pinned-games').flush({ gameIds: [] });
      await settle();
      const toggle = el().querySelector<HTMLButtonElement>('nri-calendar-pin button[role=switch]')!;
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      toggle.click();
      await settle();
      const post = http.expectOne('/api/me/calendar/pinned-games/7');
      expect(post.request.method).toBe('POST');
      post.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
    });

    it('a member of a finished game cannot leave', async () => {
      await open(me, (r) => r.flush({ ...asMember, status: 'finished' }));
      await flushMemberExtras();
      expect(el().querySelector('button.leave')).toBeNull();
    });

    it('GM of a oneshot: «convert to campaign» opens the rule dialog and reloads', async () => {
      const own = { ...game, kind: 'oneshot', recurrence: 'none', weekdays: [] } as const;
      await open(me, (r) => r.flush({ ...own, gm: { ...game.gm, publicId: me.publicId } }));
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      flushNotesAndCalendar(true);
      await settle();
      expect(el().querySelector('button.change-schedule')).toBeNull();
      nextDialog({ ...own, kind: 'campaign' });
      el().querySelector<HTMLButtonElement>('button.convert')!.click();
      await settle();
      expect(dialogOpen).toHaveBeenCalledWith(
        ScheduleRuleDialog,
        expect.objectContaining({ data: expect.objectContaining({ mode: 'convert' }) }),
      );
      expectGame().flush({ ...own, kind: 'campaign', gm: { ...game.gm, publicId: me.publicId } });
      await settle();
      http.expectOne('/api/games/7/sessions').flush([]);
      await settle();
      await settle();
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.details.converted');
      expect(el().querySelector('button.change-schedule')).not.toBeNull();
    });
  });

  it('a non-member does not request the member list', async () => {
    await open(me, (r) => r.flush(game));
    http.expectNone('/api/games/7/members');
    expect(el().querySelector('nri-members-panel')).toBeNull();
  });

  it('restricted game: blurred view without details, even if they leak; guest gets a login link', async () => {
    await open(null, (r) =>
      r.flush({
        id: 7,
        title: 'Темна вежа',
        gm: game.gm,
        ageRating: '18+',
        restricted: true,
        description: 'SECRET DESCRIPTION',
        coverUrl: 'https://example.com/secret.png',
      }),
    );
    const text = el().textContent!;
    expect(text).toContain('Темна вежа');
    expect(text).toContain('games.restricted.18+');
    expect(text).not.toContain('SECRET DESCRIPTION');
    expect(el().querySelector('img')).toBeNull();
    expect(el().querySelector('a[href^="/login"]')).not.toBeNull();
  });

  it('404 shows "not found"', async () => {
    await open(null, (r) =>
      r.flush({ error: { code: 'NOT_FOUND' } }, { status: 404, statusText: 'Not Found' }),
    );
    expect(el().textContent).toContain('games.details.notFound');
  });

  it('sets per-game meta; GM name links to the profile', async () => {
    await open(me, (r) => r.flush(game));
    const meta = TestBed.inject(Meta);
    expect(TestBed.inject(Title).getTitle()).toContain('Туман над Дніпром');
    expect(meta.getTag("name='description'")?.content).toContain('Детективна кампанія');
    expect(meta.getTag("property='og:image'")?.content).toBe('https://example.com/cover.png');
    expect(meta.getTag("name='robots'")).toBeNull();
    expect(el().querySelector('a.gm-link')!.getAttribute('href')).toBe('/users/zzzzzzzzzz');
  });

  it('GM rating next to the GM name; "no rating yet" when null', async () => {
    await open(me, (r) => r.flush({ ...game, gmRating: 4.6 }));
    const rating = el().querySelector('header .gm nri-gm-rating .gm-rating')!;
    expect(rating.textContent).toContain('4,6');
    expect(rating.getAttribute('aria-label')).toBe('ratings.gmRating.aria');
    TestBed.resetTestingModule();
    await open(me, (r) => r.flush(game));
    expect(el().querySelector('header .gm .gm-rating')).toBeNull();
    expect(el().querySelector('header .gm')!.textContent).toContain('ratings.gmRating.none');
  });

  describe('clone', () => {
    const own = { ...game, gm: { ...game.gm, publicId: me.publicId } };
    const flushGmExtras = async () => {
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      flushNotesAndCalendar(true);
      await settle();
    };
    const cloneButton = () => el().querySelector<HTMLButtonElement>('button.clone');

    it('only the GM sees (finished/cancelled too, not admin-closed) «Create a copy»', async () => {
      await open(me, (r) => r.flush(game));
      http.match('/api/games/7/members').forEach((r) => r.flush([]));
      http.match('/api/games/7/sessions').forEach((r) => r.flush([]));
      http.match('/api/me/applications').forEach((r) => r.flush([]));
      http.match('/api/me/settings').forEach((r) => r.flush({ calendarAutoBusy: true }));
      http.match('/api/games/7/notes/shared').forEach((r) => r.flush({ pages: [] }));
      await settle();
      expect(cloneButton()).toBeNull();
      TestBed.resetTestingModule();
      for (const status of ['finished', 'cancelled'] as const) {
        await open(me, (r) => r.flush({ ...own, status, nextSessionAt: null }));
        await flushGmExtras();
        expect(cloneButton()).not.toBeNull();
        TestBed.resetTestingModule();
      }
      await open(me, (r) => r.flush({ ...own, status: 'cancelled', closedByAdmin: true }));
      await flushGmExtras();
      expect(cloneButton()).toBeNull();
      TestBed.resetTestingModule();
      await open(me, (r) => r.flush(own));
      await flushGmExtras();
      expect(cloneButton()!.textContent).toContain('games.actions.clone');
    });

    it('click → POST /clone, then the copy edit form opens', async () => {
      await open(me, (r) => r.flush(own));
      await flushGmExtras();
      cloneButton()!.click();
      await settle();
      http.expectOne({ method: 'POST', url: '/api/games/7/clone' }).flush({ ...own, id: 99 });
      await settle();
      await settle();
      expect(TestBed.inject(Router).url).toBe('/games/99/edit');
    });

    it('a rejected clone shows the error and stays on the page', async () => {
      await open(me, (r) => r.flush(own));
      await flushGmExtras();
      cloneButton()!.click();
      await settle();
      http
        .expectOne({ method: 'POST', url: '/api/games/7/clone' })
        .flush({ error: { code: 'GAME_CREATION_BLOCKED' } }, { status: 409, statusText: 'x' });
      await settle();
      expect(TestBed.inject(Router).url).toBe('/games/7');
      expect(el().querySelector('.notice-area')!.textContent).toContain(
        'errors.GAME_CREATION_BLOCKED',
      );
    });
  });

  describe('campaign pause', () => {
    const own = { ...game, gm: { ...game.gm, publicId: me.publicId } };
    const paused = {
      ...own,
      status: 'paused',
      nextSessionAt: null,
      pausedAt: '2026-11-20T08:00:00.000Z',
      pauseReason: 'illness',
      pauseNote: 'Застуда, до тижня',
    } as const;
    const flushGmExtras = async () => {
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      flushNotesAndCalendar(true);
      await settle();
    };
    const flushMemberExtras = async () => {
      http.expectOne('/api/games/7/members').flush([]);
      http.expectOne('/api/games/7/sessions').flush([]);
      http.expectOne('/api/me/applications').flush([]);
      flushNotesAndCalendar(false);
      await settle();
    };
    const button = (cls: string) => el().querySelector<HTMLButtonElement>(`button.${cls}`);
    const afterChange = async (dto: object) => {
      await settle();
      expectGame().flush(dto);
      await settle();
      http.expectOne('/api/games/7/sessions').flush([]);
      await settle();
      await settle();
    };

    it('GM of a running campaign: «pause» opens the reason dialog, then reloads the game and sessions', async () => {
      await open(me, (r) => r.flush(own));
      await flushGmExtras();
      expect(button('pause')!.textContent).toContain('games.actions.pause');
      nextDialog({ ...paused });
      button('pause')!.click();
      expect(dialogOpen).toHaveBeenCalledWith(
        PauseDialog,
        expect.objectContaining({
          data: expect.objectContaining({ gameId: 7, title: 'Туман над Дніпром' }),
        }),
      );
      await afterChange(paused);
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.pause.done.pause');
      expect(button('pause')).toBeNull();
      expect(el().querySelector('.pause-panel')).not.toBeNull();
    });

    it('no «pause» for a member, a oneshot GM or a draft', async () => {
      await open(me, (r) =>
        r.flush({ ...game, viewer: { relation: 'member', applicationId: null } }),
      );
      await flushMemberExtras();
      expect(button('pause')).toBeNull();
      TestBed.resetTestingModule();
      await open(me, (r) => r.flush({ ...own, kind: 'oneshot', recurrence: 'none', weekdays: [] }));
      await flushGmExtras();
      expect(button('pause')).toBeNull();
      TestBed.resetTestingModule();
      await open(me, (r) => r.flush({ ...own, status: 'draft' }));
      expect(button('pause')).toBeNull();
    });

    it('paused, GM: panel with reason, note and date; resume / recruit / finish; no schedule change', async () => {
      await open(me, (r) => r.flush(paused));
      await flushGmExtras();
      const panel = el().querySelector<HTMLElement>('.pause-panel')!;
      expect(panel.textContent).toContain('games.pause.panel.title');
      expect(panel.textContent).toContain('games.pause.panel.reason');
      expect(panel.querySelector('.note')!.textContent).toContain('Застуда, до тижня');
      expect(panel.querySelector('.since')!.textContent).toContain('games.pause.panel.since');
      expect(el().querySelector('.badge[data-status="paused"]')!.textContent).toContain(
        'games.status.paused',
      );
      expect(button('change-schedule')).toBeNull();
      expect(button('pause')).toBeNull();
      // Нерозкладові поля редагуються й на паузі (розклад у формі вимкнено).
      expect(el().querySelector('a[href="/games/7/edit"]')).not.toBeNull();
      expect(button('resume')).not.toBeNull();
      expect(button('cancel')).not.toBeNull();
      expect(button('finish')).not.toBeNull();

      nextDialog({ ...own, status: 'started', showWhenFull: true, warning: 'BELOW_MIN_PLAYERS' });
      button('recruit')!.click();
      expect(dialogOpen).toHaveBeenCalledWith(
        ResumeDialog,
        expect.objectContaining({
          data: expect.objectContaining({
            recruit: true,
            firstStart: true,
            viewerTimezone: 'Europe/Kyiv',
            game: expect.objectContaining({ id: 7, weekdays: [1] }),
          }),
        }),
      );
      await afterChange({ ...own, status: 'started', showWhenFull: true });
      expect(el().querySelector('.notice-area')!.textContent).toContain(
        'games.pause.done.resumedBelowMin',
      );
      expect(el().querySelector('.pause-panel')).toBeNull();
    });

    it('paused, GM: «finish» asks for confirmation and POSTs finish', async () => {
      await open(me, (r) => r.flush(paused));
      await flushGmExtras();
      nextDialog(true);
      button('finish')!.click();
      await settle();
      expect(dialogOpen).toHaveBeenLastCalledWith(ConfirmDialog, expect.anything());
      const req = http.expectOne('/api/games/7/finish');
      expect(req.request.method).toBe('POST');
      req.flush({ ...own, status: 'finished' });
      await afterChange({ ...own, status: 'finished' });
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.my.done.finish');
    });

    it('paused, GM: «cancel» uses the regular cancel confirmation and POSTs cancel', async () => {
      await open(me, (r) => r.flush(paused));
      await flushGmExtras();
      nextDialog(true);
      button('cancel')!.click();
      await settle();
      expect(dialogOpen).toHaveBeenLastCalledWith(
        ConfirmDialog,
        expect.objectContaining({
          data: expect.objectContaining({ title: 'games.confirm.cancel.title', danger: true }),
        }),
      );
      http.expectOne('/api/games/7/cancel').flush({ ...own, status: 'cancelled' });
      await afterChange({ ...own, status: 'cancelled' });
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.my.done.cancel');
    });

    it('paused, outsider: panel without the private reason, no apply button, a clear hint', async () => {
      const pub = { ...paused, pauseReason: undefined, pauseNote: undefined };
      await open(me, (r) => r.flush({ ...pub, gm: game.gm }));
      expect(el().querySelector('button.apply')).toBeNull();
      expect(el().querySelector('.apply-hint')!.textContent).toContain('games.details.pausedHint');
      const panel = el().querySelector<HTMLElement>('.pause-panel')!;
      expect(panel.textContent).toContain('games.pause.panel.title');
      expect(panel.querySelector('.reason')).toBeNull();
      expect(panel.querySelector('button')).toBeNull();
    });

    it('paused, guest: no login-to-apply link, the paused hint instead', async () => {
      await open(null, (r) => r.flush({ ...paused, gm: game.gm }));
      expect(el().querySelector('a.apply-login')).toBeNull();
      expect(el().querySelector('.apply-hint')!.textContent).toContain('games.details.pausedHint');
    });

    it('?action=recruit from the long-pause reminder opens the resume dialog for the GM once', async () => {
      await open(me, (r) => r.flush(paused), '/games/7?action=recruit');
      await flushGmExtras();
      await settle();
      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(dialogOpen).toHaveBeenCalledWith(
        ResumeDialog,
        expect.objectContaining({ data: expect.objectContaining({ recruit: true }) }),
      );
    });

    it('the same ?action= quick link works again on the same page', async () => {
      await open(me, (r) => r.flush(paused), '/games/7?action=resume');
      await flushGmExtras();
      await settle();
      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(harness.routeNativeElement).toBeTruthy();
      expect(TestBed.inject(Router).url).toBe('/games/7');
      await harness.navigateByUrl('/games/7?action=resume');
      await settle();
      await settle();
      expect(dialogOpen).toHaveBeenCalledTimes(2);
      expect(dialogOpen).toHaveBeenLastCalledWith(
        ResumeDialog,
        expect.objectContaining({ data: expect.objectContaining({ recruit: false }) }),
      );
    });

    it('a quick link for a campaign that is no longer paused shows a short notice', async () => {
      await open(me, (r) => r.flush(own), '/games/7?action=recruit');
      await flushGmExtras();
      await settle();
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(el().querySelector('.notice-area')!.textContent).toContain('games.pause.linkStale');
      expect(TestBed.inject(Router).url).toBe('/games/7');
    });

    it('?action=… is ignored for a member', async () => {
      await open(
        me,
        (r) =>
          r.flush({ ...paused, gm: game.gm, viewer: { relation: 'member', applicationId: null } }),
        '/games/7?action=resume',
      );
      await flushMemberExtras();
      expect(dialogOpen).not.toHaveBeenCalled();
      expect(el().querySelector('.pause-panel')!.textContent).toContain(
        'games.pause.panel.memberHint',
      );
    });
  });

  describe('"Rate members" entry (final / leave ratings)', () => {
    const openTarget = {
      publicId: 'pppppppppp',
      nickname: 'Sam',
      avatarUrl: null,
      role: 'player_from_player',
      state: 'open',
      closesAt: null,
    };
    const rateLink = () => el().querySelector<HTMLAnchorElement>('a.rate-members-link');
    const flushTargets = async (targets: unknown[]) => {
      const req = http.expectOne(targetsUrl);
      expect(req.request.params.has('sessionId')).toBe(false);
      req.flush({ ...emptyTargets, targets });
      await settle();
    };

    it('a former member with open targets gets the link to the rate page', async () => {
      await open(me, (r) =>
        r.flush({ ...game, viewer: { relation: 'none', applicationId: null, wasMember: true } }),
      );
      await flushTargets([openTarget]);
      expect(rateLink()!.getAttribute('href')).toBe('/games/7/rate');
    });

    it('no link when everyone is rated or declined', async () => {
      await open(me, (r) =>
        r.flush({ ...game, viewer: { relation: 'none', applicationId: null, wasMember: true } }),
      );
      await flushTargets([{ ...openTarget, state: 'declined' }]);
      expect(rateLink()).toBeNull();
    });

    it('outsiders and guests do not request rating targets', async () => {
      await open(me, (r) => r.flush(game));
      http.expectNone(targetsUrl);
      expect(rateLink()).toBeNull();
    });
  });

  it('an 18+ game is not indexed', async () => {
    await open(me, (r) => r.flush({ ...game, ageRating: '18+' }));
    expect(TestBed.inject(Meta).getTag("name='robots'")?.content).toBe('noindex');
  });

  describe('time zones', () => {
    afterEach(() => vi.restoreAllMocks());

    const nextSessionText = () => {
      const dts = [...el().querySelectorAll('dl.facts dt')];
      const dt = dts.find((d) => d.textContent!.includes('games.details.nextSession'))!;
      return dt.nextElementSibling!.textContent!;
    };

    it('guest in Warsaw: same time as the search card (browser zone, no label)', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(null, (r) => r.flush(game));
      expect(nextSessionText()).toContain('18:00');
      expect(nextSessionText()).not.toMatch(/GMT|CET|EET/);
    });

    it('weekly schedule is shown in the viewer zone, without a zone', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(null, (r) => r.flush(game));
      const tr = TestBed.inject(TranslateService);
      tr.setTranslation('uk', { games: { details: { scheduleAt: 'о {{time}}' } } }, true);
      tr.use('uk');
      await settle();
      expect(el().querySelector('.schedule-zone')!.textContent!.trim()).toBe('о 18:00');
    });

    it('a windowed rule: schedule «between … and …», next session as a range with «TBD»', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(null, (r) =>
        r.flush({ ...game, startWindowMinutes: 180, nextSessionWindowMinutes: 180 }),
      );
      const tr = TestBed.inject(TranslateService);
      tr.setTranslation(
        'uk',
        { games: { details: { scheduleWindow: 'між {{time}} і {{end}}' } } },
        true,
      );
      tr.use('uk');
      await settle();
      expect(el().querySelector('.schedule-zone')!.textContent!.trim()).toBe('між 18:00 і 21:00');
      expect(nextSessionText()).toContain('18:00–21:00');
      expect(nextSessionText()).toContain('sessions.window.approxBadge');
    });

    it('a rule window across midnight: «… next day» in the schedule', async () => {
      // 19:00 Київ + 6 год = 01:00 наступного дня.
      await open(me, (r) => r.flush({ ...game, startWindowMinutes: 360 }));
      expect(el().querySelector('.schedule-zone')!.textContent).toContain(
        'games.details.scheduleWindowNextDay',
      );
    });

    it('next session pinned at the window start: exact time, no «TBD» (window from the server)', async () => {
      await open(me, (r) =>
        r.flush({ ...game, startWindowMinutes: 180, nextSessionWindowMinutes: null }),
      );
      expect(nextSessionText()).toContain('19:00');
      expect(nextSessionText()).not.toContain('–');
      expect(nextSessionText()).not.toContain('sessions.window.approxBadge');
    });

    it('an individually windowed next session of an exact rule shows its own window', async () => {
      await open(me, (r) => r.flush({ ...game, nextSessionWindowMinutes: 60 }));
      expect(nextSessionText()).toContain('19:00–20:00');
      expect(nextSessionText()).toContain('sessions.window.approxBadge');
    });

    it('a draft without a start date: «date not set yet», weekdays without a time', async () => {
      await open(me, (r) => r.flush({ ...game, startsAt: null, nextSessionAt: null }));
      expect(nextSessionText()).toContain('games.my.noStartDate');
      expect(el().querySelector('.schedule-zone')).toBeNull();
    });

    it('signed-in viewer uses the account zone, not the browser', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(me, (r) => r.flush(game));
      expect(nextSessionText()).toContain('19:00');
      expect(nextSessionText()).not.toMatch(/GMT|EET/);
    });
  });
});
