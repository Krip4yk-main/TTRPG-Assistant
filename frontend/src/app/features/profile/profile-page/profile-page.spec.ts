import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Meta } from '@angular/platform-browser';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { CatalogDto, GameCardDto, MeDto, PublicProfileDto } from '@nri/shared';
import { ProfilePage } from './profile-page';
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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true },
  identities: [],
} satisfies MeDto;

const catalog: CatalogDto = {
  systems: [
    { id: 1, slug: 'dnd5e', name: 'D&D 5e', defaultGenreId: 1 },
    { id: 2, slug: 'coc', name: 'Call of Cthulhu', defaultGenreId: 1 },
  ],
  genres: [{ id: 1, slug: 'fantasy' }],
  contentWarnings: [],
};

const game: GameCardDto = {
  id: 7,
  title: 'Туман над Дніпром',
  summary: null,
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'offline',
  city: 'Київ',
  nextSessionAt: null,
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  kind: 'campaign',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
};

describe('ProfilePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  const settle = async () => {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  };
  const el = () => harness.routeNativeElement!;

  async function open(user: MeDto | null, publicId: string, profile: PublicProfileDto | 404) {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(
          [
            { path: 'users/:publicId', component: ProfilePage },
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
    await harness.navigateByUrl(`/users/${publicId}`, ProfilePage);
    await settle();
    http.expectOne('/api/catalog').flush(catalog);
    const req = http.expectOne(`/api/users/${publicId}`);
    if (profile === 404) req.flush({}, { status: 404, statusText: 'Not Found' });
    else req.flush(profile);
    await settle();
  }

  afterEach(() => http.verify());

  it("does not render hidden fields on someone else's profile", async () => {
    await open(me, 'zzzzzzzzzz', {
      publicId: 'zzzzzzzzzz',
      status: 'active',
      nickname: 'Gandalf',
      avatarUrl: null,
      // bio, city і favoriteSystemIds приховані — їх немає в JSON.
      preferredFormats: ['online'],
      experience: 'veteran',
      gamesAsGm: [game],
      gamesAsPlayer: [],
      ratings: { gm: null, playerFromGm: null, playerFromPlayer: null },
    });
    const text = el().textContent!;
    expect(el().querySelector('h1')!.textContent).toContain('Gandalf');
    expect(el().querySelector('[data-field="bio"]')).toBeNull();
    expect(el().querySelector('[data-field="city"]')).toBeNull();
    expect(el().querySelector('[data-field="favoriteSystems"]')).toBeNull();
    expect(el().querySelector('[data-field="preferredFormats"]')).not.toBeNull();
    expect(text).toContain('profile.experience.veteran');
    expect(el().querySelectorAll('nri-game-card')).toHaveLength(1);
    // Свій профіль редагують, чужий — ні.
    expect(el().querySelector('a[href="/profile/edit"]')).toBeNull();
  });

  it('renders visible fields, catalog system names and an edit link on my own profile', async () => {
    await open(me, me.publicId, {
      publicId: me.publicId,
      status: 'active',
      nickname: 'Frodo',
      avatarUrl: null,
      bio: 'Люблю хоррор',
      city: 'Львів',
      favoriteSystemIds: [2],
      preferredFormats: [],
      gamesAsGm: [],
      gamesAsPlayer: [],
      ratings: { gm: null, playerFromGm: null, playerFromPlayer: null },
    });
    expect(el().querySelector('[data-field="bio"]')!.textContent).toContain('Люблю хоррор');
    expect(el().querySelector('[data-field="city"]')!.textContent).toContain('Львів');
    expect(el().querySelector('[data-field="favoriteSystems"]')!.textContent).toContain(
      'Call of Cthulhu',
    );
    expect(el().querySelector('a[href="/profile/edit"]')).not.toBeNull();
  });

  it('shows the GM rating and the player rating from GMs and from players', async () => {
    await open(me, 'zzzzzzzzzz', {
      publicId: 'zzzzzzzzzz',
      status: 'active',
      nickname: 'Gandalf',
      avatarUrl: null,
      gamesAsGm: [],
      gamesAsPlayer: [],
      ratings: {
        gm: { overall: 4.6, units: 12, criteria: { preparation: 4.8, safety: 5 } },
        playerFromGm: null,
        playerFromPlayer: { overall: 3.9, units: 5, criteria: {} },
      },
    });
    const block = (k: string) => el().querySelector<HTMLElement>(`[data-rating="${k}"]`)!;
    expect(block('gm').textContent).toContain('4,6');
    expect(block('gm').textContent).toContain('ratings.units.many');
    expect(block('gm').querySelector('[data-criterion="preparation"]')!.textContent).toContain(
      '4,8',
    );
    expect(block('playerFromGm').textContent).toContain('ratings.profile.fromGm');
    expect(block('playerFromGm').textContent).toContain('ratings.summary.none');
    expect(block('playerFromPlayer').textContent).toContain('ratings.profile.fromPlayer');
    expect(block('playerFromPlayer').textContent).toContain('3,9');
  });

  it('a deleted user shows only "deleted user" and is not indexed', async () => {
    await open(null, 'xxxxxxxxxx', {
      publicId: 'xxxxxxxxxx',
      status: 'deleted',
      ratings: { gm: null, playerFromGm: null, playerFromPlayer: null },
    });
    expect(el().querySelector('h1')!.textContent).toContain('user.deleted');
    expect(el().querySelector('[data-field]')).toBeNull();
    expect(TestBed.inject(Meta).getTag("name='robots'")?.content).toBe('noindex');
  });

  const other: PublicProfileDto = {
    publicId: 'zzzzzzzzzz',
    status: 'active',
    nickname: 'Gandalf',
    avatarUrl: null,
    gamesAsGm: [],
    gamesAsPlayer: [],
    ratings: { gm: null, playerFromGm: null, playerFromPlayer: null },
  };

  it("«Complain» is offered on someone else's profile", async () => {
    await open(me, 'zzzzzzzzzz', other);
    expect(el().querySelector('button.complain')!.textContent).toContain(
      'moderation.complain.button',
    );
  });

  it('no «Complain» on my own profile', async () => {
    await open(me, me.publicId, { ...other, publicId: me.publicId, nickname: me.nickname });
    expect(el().querySelector('button.complain')).toBeNull();
  });

  it('no «Complain» for guests', async () => {
    await open(null, 'zzzzzzzzzz', other);
    expect(el().querySelector('button.complain')).toBeNull();
  });

  it('a globally blocked account is labelled «Account blocked»', async () => {
    await open(null, 'zzzzzzzzzz', { ...other, blocked: true });
    expect(el().querySelector('h1 nri-blocked-badge')!.textContent).toContain('moderation.blocked');
  });

  it('shows "not found" for an unknown user', async () => {
    await open(null, 'nnnnnnnnnn', 404);
    expect(el().textContent).toContain('profile.page.notFound');
  });
});
