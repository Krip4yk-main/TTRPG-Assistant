import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
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
import { ConfirmDialog } from '../../../shared/confirm-dialog/confirm-dialog';

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
  freeSlots: 2,
  publishedAt: '2026-11-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  cancelledAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
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
  /** Наступний `dialog.open(...)` закриється з `result`. */
  const nextDialog = (result: unknown) =>
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(result) });

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;

  async function open(user: MeDto | null, respond: (r: ReturnType<typeof expectGame>) => void) {
    dialogOpen = vi.fn();
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
            on: () => new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    });
    TestBed.inject(AuthStore).setMe(user);
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/games/7', GameDetails);
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    respond(expectGame());
    await settle();
  }
  const expectGame = () => http.expectOne('/api/games/7');

  afterEach(() => http.verify());

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

    it('guest in Warsaw: same time as the search card (browser zone, labelled)', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(null, (r) => r.flush(game));
      expect(nextSessionText()).toContain('18:00');
      expect(nextSessionText()).toContain('GMT+1');
    });

    it('weekdays are labelled with the game time and zone', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(null, (r) => r.flush(game));
      const tr = TestBed.inject(TranslateService);
      tr.setTranslation('uk', { games: { details: { scheduleAt: 'о {{time}} ({{tz}})' } } }, true);
      tr.use('uk');
      await settle();
      expect(el().querySelector('.schedule-zone')!.textContent).toContain('о 19:00 (Europe/Kyiv)');
    });

    it('signed-in viewer uses the account zone, not the browser', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      await open(me, (r) => r.flush(game));
      expect(nextSessionText()).toContain('19:00');
      expect(nextSessionText()).not.toMatch(/GMT|EET/);
    });
  });
});
