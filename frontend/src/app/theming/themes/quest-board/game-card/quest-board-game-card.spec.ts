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
  /** Справжній перехід роутера (до підміни шпигуном). */
  let realNavigate: (url: string) => Promise<boolean>;

  async function mount(prefs: UiPrefsDto = { tearAnimation: true, sendAnimation: true }) {
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
    const router = TestBed.inject(Router);
    realNavigate = router.navigateByUrl.bind(router);
    vi.spyOn(router, 'navigateByUrl').mockImplementation((url) => navigate(url));
    return create();
  }

  /** Ще одне оголошення на тій самій «сторінці». */
  async function create(id = game.id, patch: Partial<SearchGameCardDto> = {}) {
    const fixture = TestBed.createComponent(QuestBoardGameCard);
    fixture.componentRef.setInput(
      'game',
      toGameCardVm({ ...game, id, ...patch }, null, { guest: false, genreKey: () => null }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    document.body.appendChild(fixture.nativeElement);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    click(article(f));
    click(article(f));
    vi.advanceTimersByTime(TEAR_MS * 2);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('назва (і Enter на ній) — та сама анімація замість звичайного переходу посилання', async () => {
    const f = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const link = article(f).querySelector<HTMLAnchorElement>('h2 a')!;
    expect(link.getAttribute('href')).toBe('/games/7');
    const ev = click(link, { detail: 0 });
    expect(ev.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
  });

  it('анімацію вимкнено в профілі — перехід одразу, текст можна виділяти', async () => {
    const f = await mount({ tearAnimation: false, sendAnimation: true });
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
    const f = await mount({ tearAnimation: false, sendAnimation: true });
    navigate.mockResolvedValueOnce(false);
    click(article(f));
    await f.whenStable();
    click(article(f));
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('виділення тексту деінде на сторінці не блокує клік по оголошенню', async () => {
    const f = await mount();
    const outside = document.createElement('p');
    outside.textContent = 'Заголовок сторінки';
    document.body.appendChild(outside);
    document.getSelection()!.selectAllChildren(outside);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    click(article(f));
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
    document.getSelection()!.removeAllRanges();
    outside.remove();
  });

  it('анімацію вимкнено й виділено текст цього оголошення — клік не відкриває гру', async () => {
    const f = await mount({ tearAnimation: false, sendAnimation: true });
    document.getSelection()!.selectAllChildren(article(f).querySelector('.sys')!);
    click(article(f).querySelector('.sys')!);
    expect(navigate).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
  });

  it('два оголошення поспіль під час анімації — перехід лише на перше', async () => {
    const f = await mount();
    const other = await create(8);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    click(article(f));
    click(article(other));
    vi.advanceTimersByTime(TEAR_MS * 2);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
    other.detectChanges();
    expect(article(other).classList).not.toContain('qb-tearing');
  });

  it('інший перехід під час анімації скасовує відривання й повертає аркуш', async () => {
    const f = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    click(article(f));
    // Справжній перехід деінде (маршрутів у тесті немає — він завершиться помилкою, але
    // NavigationStart уже прозвучить).
    await realNavigate('/calendar').catch(() => false);
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).not.toHaveBeenCalled();
    f.detectChanges();
    expect(article(f).classList).not.toContain('qb-tearing');
    // Можна відкрити знову — блокування «одне відривання» знято.
    click(article(f));
    vi.advanceTimersByTime(TEAR_MS);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/games/7');
  });

  it('помилка переходу — аркуш повертається на місце, клік працює знову', async () => {
    const f = await mount({ tearAnimation: false, sendAnimation: true });
    navigate.mockRejectedValueOnce(new Error('chunk load failed'));
    click(article(f));
    await f.whenStable();
    await Promise.resolve();
    click(article(f));
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  describe('короткий опис, обрис і вкладка-обкладинка', () => {
    const COVER = 'https://example.com/cover.png';
    const attachment = (f: ComponentFixture<QuestBoardGameCard>) =>
      f.nativeElement.querySelector('nri-qb-attachment') as HTMLElement | null;

    it('опис під назвою (з підказкою), без опису — нічого', async () => {
      await mount();
      const f = await create(8, { summary: 'Готичний жах у тумані.' });
      const desc = article(f).querySelector('h2 + .desc')!;
      expect(desc.textContent).toContain('Готичний жах у тумані.');
      const plain = await create(9);
      expect(article(plain).querySelector('.desc')).toBeNull();
    });

    it('обрис пергаменту — за id, у сусідніх ігор різний', async () => {
      await mount();
      const papers = [];
      for (const id of [10, 11, 12]) papers.push(article(await create(id)).dataset['paper']);
      expect(new Set(papers).size).toBe(3);
    });

    it('без обкладинки вкладки немає; з обкладинкою — кнопка з назвою гри', async () => {
      const f = await mount();
      expect(attachment(f)).toBeNull();
      const withCover = await create(8, { coverUrl: COVER });
      const button = attachment(withCover)!.querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe('Арт до гри: Туман над Дніпром');
      const img = button.querySelector('img')!;
      expect(img.getAttribute('src')).toBe(COVER);
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('клік по вкладці перемикає її наперед і назад, гру не відкриває', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      const button = host.querySelector('button')!;
      click(button);
      f.detectChanges();
      expect(host.classList).toContain('front');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(article(f).classList).not.toContain('qb-tearing');
      click(button);
      f.detectChanges();
      expect(host.classList).not.toContain('front');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('клік по місцю вкладки (картинка вже виїхала наперед) лише перемикає її', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      const ev = click(host);
      f.detectChanges();
      expect(host.classList).toContain('front');
      expect(ev.defaultPrevented).toBe(false);
      expect(article(f).classList).not.toContain('qb-tearing');
      click(host);
      f.detectChanges();
      expect(host.classList).not.toContain('front');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('наперед, клік по місцю вкладки поза кнопкою (кнопка втрачає фокус) — закриває', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      const button = host.querySelector('button')!;
      button.focus();
      click(button);
      f.detectChanges();
      expect(host.classList).toContain('front');
      // Справжній порядок подій миші: pointerdown → blur кнопки → click по хосту.
      host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      button.blur();
      click(host);
      f.detectChanges();
      expect(host.classList).not.toContain('front');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('Esc (фокус деінде) повертає вкладку й скасовує збільшення від наведення', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      click(host.querySelector('button')!);
      f.detectChanges();
      const hover = vi.spyOn(host, 'matches').mockImplementation((sel) => sel === ':hover');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      f.detectChanges();
      expect(host.classList).not.toContain('front');
      expect(host.classList).toContain('dismissed');
      hover.mockRestore();
      host.dispatchEvent(new MouseEvent('mouseleave'));
      f.detectChanges();
      expect(host.classList).not.toContain('dismissed');
    });

    it('дотик деінде повертає вкладку; дотик по ній самій — ні', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      const button = host.querySelector('button')!;
      click(button);
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      f.detectChanges();
      expect(host.classList).toContain('front');
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      f.detectChanges();
      expect(host.classList).not.toContain('front');
    });

    it('фокус лише показує рамку; Enter / Space (клік кнопки) перемикає, втрата фокуса — повертає', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      const button = host.querySelector('button')!;
      button.focus();
      f.detectChanges();
      expect(host.classList).not.toContain('front');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      click(button); // Enter / Space на кнопці = click
      f.detectChanges();
      expect(host.classList).toContain('front');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      button.blur();
      f.detectChanges();
      expect(host.classList).not.toContain('front');
    });

    it('картинка не завантажилась — вкладку сховано; нова адреса — знову видно', async () => {
      await mount();
      const f = await create(8, { coverUrl: COVER });
      const host = attachment(f)!;
      host.querySelector('img')!.dispatchEvent(new Event('error'));
      f.detectChanges();
      expect(host.classList).toContain('failed');
      expect(getComputedStyle(host).display).toBe('none');
      f.componentRef.setInput(
        'game',
        toGameCardVm({ ...game, id: 8, coverUrl: 'https://example.com/other.png' }, null, {
          guest: false,
          genreKey: () => null,
        }),
      );
      f.detectChanges();
      expect(host.classList).not.toContain('failed');
    });
  });
});
