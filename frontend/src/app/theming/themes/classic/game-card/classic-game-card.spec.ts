import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { RestrictedGameDto, SearchGameCardDto } from '@nri/shared';
import { ClassicGameCard } from './classic-game-card';
import { browserZone } from '../../../../core/i18n/dates';
import { AuthStore } from '../../../../core/auth/auth.store';
import { toGameCardVm } from '../../../../core/games/game-card.vm';

const game: SearchGameCardDto = {
  id: 5,
  title: 'Туман над Дніпром',
  coverUrl: 'https://example.com/cover.png',
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'offline',
  city: 'Київ',
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: 150,
  ageRating: '18+',
  kind: 'campaign',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
  fit: 'partial',
};

const restricted: RestrictedGameDto = {
  id: 6,
  title: 'Темна вежа',
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  ageRating: '21+',
  restricted: true,
};

describe('ClassicGameCard (slot «game-card»)', () => {
  let fixture: ComponentFixture<ClassicGameCard>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClassicGameCard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ClassicGameCard);
    el = fixture.nativeElement as HTMLElement;
  });

  // Картка отримує view-model, як від контейнера `nri-game-card` (той самий шлях даних).
  const render = async (g: object, guest = false) => {
    const vm = toGameCardVm(g as SearchGameCardDto, TestBed.inject(AuthStore).me(), {
      guest,
      genreKey: () => null,
    });
    fixture.componentRef.setInput('game', vm);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('renders the card fields, a link to the game and the fit badge', async () => {
    await render(game);
    expect(el.textContent).toContain('Туман над Дніпром');
    expect(el.textContent).toContain('D&D 5e');
    expect(el.textContent).toContain('Київ');
    expect(el.textContent).toContain('Gandalf');
    expect(el.querySelector('.fit')!.textContent).toContain('search.fit.partial');
    expect(el.querySelector('.age')!.textContent).toContain('18+');
    expect(el.querySelector('a[href="/games/5"]')).not.toBeNull();
  });

  it('no fit badge when the calendar filter is off', async () => {
    await render({ ...game, fit: undefined });
    expect(el.querySelector('.fit')).toBeNull();
  });

  it('no status badge while recruiting', async () => {
    await render(game);
    expect(el.querySelector('.status')).toBeNull();
  });

  for (const status of ['started', 'finished', 'cancelled'] as const) {
    it(`shows a translated status badge for ${status}`, async () => {
      await render({ ...game, fit: undefined, ageRating: 'none', status });
      const badge = el.querySelector('.badge.status');
      expect(badge).not.toBeNull();
      expect(badge!.getAttribute('data-status')).toBe(status);
      expect(badge!.textContent).toContain(`games.status.${status}`);
    });
  }

  it('finished/cancelled cards hide the next session and free seats', async () => {
    for (const status of ['finished', 'cancelled'] as const) {
      await render({ ...game, status });
      expect(el.textContent).not.toContain('search.card.next');
      expect(el.textContent).not.toContain('search.card.slots');
      expect(el.textContent).toContain('search.card.price');
    }
    await render({ ...game, status: 'started' });
    expect(el.textContent).toContain('search.card.next');
    expect(el.textContent).toContain('search.card.slots');
  });

  it('restricted card is blurred and never renders details, even if they leak', async () => {
    await render({
      ...restricted,
      description: 'SECRET DESCRIPTION',
      coverUrl: 'https://example.com/secret.png',
      city: 'Секретне місто',
    });
    expect(el.querySelector('.restricted')).not.toBeNull();
    expect(el.textContent).toContain('Темна вежа');
    expect(el.textContent).toContain('games.restricted.21+');
    expect(el.textContent).not.toContain('SECRET DESCRIPTION');
    expect(el.textContent).not.toContain('Секретне місто');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a[href^="/login"]')).toBeNull();
  });

  it('shows the GM overall rating; "no rating yet" when there is none', async () => {
    await render({ ...game, gmRating: 4.25 });
    expect(el.querySelector('.gm .gm-rating')!.textContent).toContain('4,3');
    await render(game);
    expect(el.querySelector('.gm-rating')).toBeNull();
    expect(el.querySelector('.gm .none')!.textContent).toContain('ratings.gmRating.none');
  });

  it('a blocked GM is labelled «Account blocked» on full and restricted cards', async () => {
    await render(game);
    expect(el.querySelector('nri-blocked-badge')).toBeNull();
    await render({ ...game, gm: { ...game.gm, blocked: true } });
    expect(el.querySelector('.gm nri-blocked-badge')!.textContent).toContain('moderation.blocked');
    await render({ ...restricted, gm: { ...restricted.gm, blocked: true } });
    expect(el.querySelector('.gm nri-blocked-badge')).not.toBeNull();
  });

  it('restricted card has no rating even if it leaks', async () => {
    await render({ ...restricted, gmRating: 4.8 });
    expect(el.querySelector('nri-gm-rating')).toBeNull();
  });

  it('restricted card invites a guest to log in', async () => {
    await render(restricted, true);
    const login = el.querySelector<HTMLAnchorElement>('a[href^="/login"]');
    expect(login).not.toBeNull();
    expect(decodeURIComponent(login!.getAttribute('href')!)).toContain('returnTo=/games/6');
  });

  describe('session time zone', () => {
    afterEach(() => vi.restoreAllMocks());

    it('guest in Warsaw sees the browser-zone time with a zone label', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      TestBed.inject(AuthStore).setMe(null);
      await render(game, true);
      const next = el.querySelector('.facts dd')!.textContent!;
      expect(next).toContain('18:00');
      expect(next).toContain('GMT+1');
    });

    it('viewer in the game zone sees no zone label', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Kyiv');
      TestBed.inject(AuthStore).setMe(null);
      await render(game, true);
      const next = el.querySelector('.facts dd')!.textContent!;
      expect(next).toContain('19:00');
      expect(next).not.toMatch(/GMT|EET/);
    });
  });
});
