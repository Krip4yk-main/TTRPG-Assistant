import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import type { RestrictedGameDto, SearchGameCardDto } from '@nri/shared';
import { CyberGameCard } from './cyber-game-card';
import { browserZone } from '../../../../core/i18n/dates';
import { AuthStore } from '../../../../core/auth/auth.store';
import {
  toGameCardVm,
  type BadgeVm,
  type FullGameCardVm,
} from '../../../../core/games/game-card.vm';
import { neonOf } from '../neon';

const game: SearchGameCardDto = {
  id: 5,
  title: 'Туман над Дніпром',
  summary: 'Готичний жах у тумані.',
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

describe('CyberGameCard (slot «game-card»)', () => {
  let fixture: ComponentFixture<CyberGameCard>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CyberGameCard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CyberGameCard);
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
      expect(el.textContent).not.toContain('cyber.card.when');
      expect(el.textContent).not.toContain('search.card.slots');
      expect(el.textContent).toContain('cyber.price.label');
    }
    await render({ ...game, status: 'started' });
    expect(el.textContent).toContain('cyber.card.when');
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

  it('the GM role line tooltip is the full visible text, with or without a rating', async () => {
    TestBed.inject(TranslateService).setTranslation('uk', {
      cyber: {
        gmRole: {
          plain: 'майстер',
          rated: 'майстер · ★ {{rating}}',
          none: 'майстер · ще немає рейтингу',
        },
      },
    });
    TestBed.inject(TranslateService).use('uk');
    const tip = () =>
      fixture.debugElement.query(By.css('.gm .role')).injector.get(MatTooltip).message;
    await render({ ...game, gmRating: 4.5 });
    expect(tip()).toBe('майстер · ★ 4,5');
    await render(game);
    expect(tip()).toBe('майстер · ще немає рейтингу');
    await render(restricted);
    expect(tip()).toBe('майстер');
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

  it('neon colour on the host is stable per game id; neighbouring games differ', async () => {
    await render(game);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('data-neon')).toBe(neonOf(5));
    await render({ ...game, id: 6 });
    expect(host.getAttribute('data-neon')).toBe(neonOf(6));
    expect(neonOf(6)).not.toBe(neonOf(5));
  });

  it('has the decorative hooks of all three cyber variants, hidden from screen readers', async () => {
    for (const g of [game, restricted]) {
      await render(g);
      for (const cls of [
        'cy-spill',
        'cy-rail',
        'cy-clamp-l',
        'cy-clamp-r',
        'cy-frame',
        'cy-beam',
        'cy-emitter',
        'cy-tube',
        'cy-rivets',
        'cy-brackets',
      ]) {
        const deco = el.querySelector(`.${cls}`);
        expect(deco, cls).not.toBeNull();
        expect(deco!.getAttribute('aria-hidden'), cls).toBe('true');
      }
    }
  });

  it('cover is a cyber attachment named after the game; no cover — no attachment', async () => {
    await render(game);
    const att = el.querySelector('nri-cy-attachment')!;
    expect(att.querySelector('button')!.getAttribute('aria-label')).toBe('cyber.attachment.label');
    expect(att.querySelector('img')!.getAttribute('src')).toBe(game.coverUrl);
    await render({ ...game, coverUrl: null });
    expect(el.querySelector('nri-cy-attachment')).toBeNull();
  });

  it('seat pips light up the free seats; many seats — text only', async () => {
    await render(game);
    expect(el.querySelectorAll('.pips b')).toHaveLength(5);
    expect(el.querySelectorAll('.pips b.on')).toHaveLength(2);
    await render({ ...game, maxPlayers: 12, freeSlots: 7 });
    expect(el.querySelector('.pips')).toBeNull();
    expect(el.textContent).toContain('search.card.slotsValue');
  });

  it('free game shows a «free» price sign', async () => {
    await render({ ...game, priceUah: null });
    const price = el.querySelector('.price')!;
    expect(price.classList).toContain('free');
    expect(price.textContent).toContain('cyber.price.free');
  });

  it('marks beyond two collapse into «+N» (all still read by screen readers)', async () => {
    const base = toGameCardVm(game, null, { guest: false, genreKey: () => null });
    const extra: BadgeVm[] = Array.from({ length: 4 }, (_, i) => ({
      kind: 'status',
      value: 'x',
      labelKey: `mark.${i}`,
      icon: null,
    }));
    fixture.componentRef.setInput('game', {
      ...(base as FullGameCardVm),
      badges: [...base.badges, ...extra],
    });
    fixture.detectChanges();
    // fit — окремо; у рядку: 18+ і mark.0, «+3» (mark.1…3 — лише для читачів екрана).
    expect(el.querySelector('.more')!.textContent).toContain('+3');
    expect(el.querySelector('.marks .nri-visually-hidden')!.textContent).toContain('mark.3');
    expect(el.querySelector('.fit')!.textContent).toContain('search.fit.partial');
  });

  describe('whole card opens the game', () => {
    let navigate: ReturnType<typeof vi.fn<(url: unknown) => Promise<boolean>>>;

    beforeEach(() => {
      navigate = vi.fn<(url: unknown) => Promise<boolean>>(async () => true);
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation((url) => navigate(url));
    });

    afterEach(() => vi.restoreAllMocks());

    const click = (target: Element, init: MouseEventInit = {}) => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      target.dispatchEvent(ev);
      return ev;
    };

    it('a click on the card body navigates once (a double click too)', async () => {
      await render(game);
      const ev = click(el.querySelector('.facts')!);
      expect(ev.defaultPrevented).toBe(true);
      click(el.querySelector('.desc')!);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith('/games/5');
    });

    it('a click on the title link navigates once (link and card do not both navigate)', async () => {
      await render(game);
      const link = el.querySelector<HTMLAnchorElement>('h2 a.open')!;
      expect(link.getAttribute('href')).toBe('/games/5');
      const ev = click(link);
      expect(ev.defaultPrevented).toBe(true); // браузер сам не переходить
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('a click on the cover attachment never navigates', async () => {
      await render(game);
      const att = el.querySelector('nri-cy-attachment')!;
      click(att.querySelector('button')!);
      click(att);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('GM link, modifier / middle clicks and selecting card text do not open the game', async () => {
      await render(game);
      click(el.querySelector('a[href="/users/zzzzzzzzzz"]')!);
      click(el.querySelector('.facts')!, { ctrlKey: true });
      click(el.querySelector('.facts')!, { button: 1 });
      const desc = el.querySelector('.desc')!;
      document.body.appendChild(el);
      document.getSelection()!.selectAllChildren(desc);
      click(desc);
      document.getSelection()!.removeAllRanges();
      el.remove();
      // Посилання майстра переходить само (RouterLink) — але не на гру.
      const urls = navigate.mock.calls.map(([u]) => String(u));
      expect(urls).toEqual(['/users/zzzzzzzzzz']);
    });

    it('a failed or cancelled navigation lets the next click try again', async () => {
      await render(game);
      navigate.mockResolvedValueOnce(false);
      click(el.querySelector('.facts')!);
      await Promise.resolve();
      await Promise.resolve();
      click(el.querySelector('.facts')!);
      expect(navigate).toHaveBeenCalledTimes(2);
    });

    it('after a finished navigation the surviving card opens the game again', async () => {
      await render(game);
      click(el.querySelector('.facts')!);
      await Promise.resolve();
      await Promise.resolve();
      click(el.querySelector('.facts')!);
      expect(navigate).toHaveBeenCalledTimes(2);
    });

    it('restricted card opens the game; its login link does not', async () => {
      await render(restricted, true);
      click(el.querySelector('a[href^="/login"]')!);
      expect(navigate.mock.calls.map(([u]) => String(u))).not.toContain('/games/6');
      click(el.querySelector('.restricted-text')!);
      expect(navigate).toHaveBeenCalledWith('/games/6');
    });
  });

  describe('session time zone', () => {
    afterEach(() => vi.restoreAllMocks());

    it('guest in Warsaw sees the browser-zone time without a zone label', async () => {
      vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Warsaw');
      TestBed.inject(AuthStore).setMe(null);
      await render(game, true);
      const next = el.querySelector('.facts dd')!.textContent!;
      expect(next).toContain('18:00');
      expect(next).not.toMatch(/GMT|EET|CET/);
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
