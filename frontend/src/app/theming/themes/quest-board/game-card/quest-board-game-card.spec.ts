import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import type { SearchGameCardDto, UiPrefsDto } from '@nri/shared';
import uk from '../../../../../assets/i18n/uk.json';
import { toGameCardVm } from '../../../../core/games/game-card.vm';
import { ThemeService } from '../../../theme.service';
import { QuestBoardGameCard, TEAR_MS } from './quest-board-game-card';

const game = {
  id: 7,
  title: 'Туман над Дніпром',
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'online',
  city: null,
  nextSessionAt: null,
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  kind: 'oneshot',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
} as unknown as SearchGameCardDto;

/** Відривання оголошення: увесь аркуш відкриває гру, анімація — за налаштуванням профілю. */
describe('QuestBoardGameCard — клік і відривання', () => {
  let navigate: ReturnType<typeof vi.fn<(url: unknown) => Promise<boolean>>>;
  let reducedMotion = false;

  async function mount(prefs: UiPrefsDto = { tearAnimation: true }) {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ lang: 'uk' }),
        { provide: ThemeService, useValue: { uiPrefs: signal(prefs) } },
      ],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('uk', uk);
    t.use('uk');
    navigate = vi.fn<(url: unknown) => Promise<boolean>>(async () => true);
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation((url) => navigate(url));
    const fixture = TestBed.createComponent(QuestBoardGameCard);
    fixture.componentRef.setInput(
      'game',
      toGameCardVm(game, null, { guest: false, genreKey: () => null }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const article = (f: ComponentFixture<QuestBoardGameCard>) =>
    f.nativeElement.querySelector('article') as HTMLElement;
  const click = (el: Element, init: MouseEventInit = {}) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    reducedMotion = false;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reducedMotion })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('клік по аркушу: спершу анімація відривання, потім перехід на гру', async () => {
    const f = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    click(article(f).querySelector('.sys')!);
    f.detectChanges();
    expect(article(f).classList).toContain('qb-tearing');
    expect(f.nativeElement.querySelector('.qb-tear-stub')).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
  });

  it('подвійний клік — один перехід', async () => {
    const f = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    click(article(f));
    click(article(f));
    vi.advanceTimersByTime(TEAR_MS * 2);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('назва (і Enter на ній) — та сама анімація замість звичайного переходу посилання', async () => {
    const f = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const link = article(f).querySelector<HTMLAnchorElement>('h2 a')!;
    expect(link.getAttribute('href')).toBe('/games/7');
    const ev = click(link, { detail: 0 });
    expect(ev.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
  });

  it('анімацію вимкнено в профілі — перехід одразу, текст можна виділяти', async () => {
    const f = await mount({ tearAnimation: false });
    expect(article(f).classList).not.toContain('qb-tearable');
    click(article(f));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
    f.detectChanges();
    expect(article(f).classList).not.toContain('qb-tearing');
  });

  it('prefers-reduced-motion — перехід одразу, без анімації', async () => {
    reducedMotion = true;
    const f = await mount();
    click(article(f));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
    f.detectChanges();
    expect(article(f).classList).not.toContain('qb-tearing');
  });

  it('клік по внутрішньому посиланню (майстер) — його власна дія, не перехід на гру', async () => {
    const f = await mount();
    const gm = article(f).querySelector<HTMLAnchorElement>('a[href="/users/zzzzzzzzzz"]')!;
    gm.addEventListener('click', (e) => e.preventDefault());
    click(gm);
    f.detectChanges();
    expect(article(f).classList).not.toContain('qb-tearing');
    expect(navigate).not.toHaveBeenCalledWith('/games/7');
  });

  it('Ctrl/середня кнопка — звична поведінка посилання (нова вкладка), без анімації', async () => {
    const f = await mount();
    const link = article(f).querySelector<HTMLAnchorElement>('h2 a')!;
    const ev = click(link, { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    f.detectChanges();
    expect(article(f).classList).not.toContain('qb-tearing');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('скасований перехід повертає аркуш на місце', async () => {
    const f = await mount({ tearAnimation: false });
    navigate.mockResolvedValueOnce(false);
    click(article(f));
    await f.whenStable();
    click(article(f));
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
