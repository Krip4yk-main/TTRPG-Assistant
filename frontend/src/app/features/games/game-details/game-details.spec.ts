import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { CatalogDto, MeDto, PublicGameDto } from '@nri/shared';
import { GameDetails } from './game-details';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

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
};

describe('GameDetails', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;

  async function open(user: MeDto | null, respond: (r: ReturnType<typeof expectGame>) => void) {
    await TestBed.configureTestingModule({
      providers: [
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

  it('shows full info, warnings as chips and a disabled apply button with a hint', async () => {
    await open(me, (r) => r.flush(game));
    const text = el().textContent!;
    expect(text).toContain('Туман над Дніпром');
    expect(text).toContain('Детективна кампанія');
    expect(text).toContain('D&D 5e');
    expect(text).toContain('Київ');
    expect(el().querySelector<HTMLImageElement>('img.cover')!.alt).toBeTruthy();
    expect(el().querySelectorAll('nri-warning-chip')).toHaveLength(3);

    const apply = el().querySelector<HTMLButtonElement>('button.apply')!;
    expect(apply.disabled).toBe(true);
    const hintId = apply.getAttribute('aria-describedby')!;
    expect(el().querySelector(`#${hintId}`)!.textContent).toContain('games.details.applySoon');
    expect(el().querySelector('a[href="/games/7/edit"]')).toBeNull();
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
});
