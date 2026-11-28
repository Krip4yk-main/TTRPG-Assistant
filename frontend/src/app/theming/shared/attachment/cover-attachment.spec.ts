import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal, type Type } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { MyGameCardDto, SearchGameCardDto } from '@nri/shared';
import { toGameCardVm } from '../../../core/games/game-card.vm';
import { toMyGameItemVm } from '../../../core/games/my-game-item.vm';
import { ThemeService } from '../../theme.service';
import { QuestBoardGameCard } from '../../themes/quest-board/game-card/quest-board-game-card';
import { QuestBoardMyGameItem } from '../../themes/quest-board/my-game-item/quest-board-my-game-item';
import { SceneGameCard } from '../../themes/scene/game-card/scene-game-card';
import { SceneMyGameItem } from '../../themes/scene/my-game-item/scene-my-game-item';

const COVER = 'https://example.com/cover.png';

const game = {
  id: 8,
  title: 'Туман над Дніпром',
  summary: null,
  coverUrl: COVER,
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

const myGame = {
  ...game,
  minPlayers: 2,
  memberCount: 1,
  pendingApplications: 0,
  seen: 'seen',
  staleness: 'ok',
  suspicious: false,
} as unknown as MyGameCardDto;

type Case = [design: string, component: Type<unknown>, selector: string, inputs: () => object];

const cardInputs = () => ({
  game: toGameCardVm(game, null, { guest: false, genreKey: () => null }),
});
const itemInputs = () => ({ item: toMyGameItemVm(myGame, { me: null, seen: null }), busy: false });

/**
 * Обкладинка-вкладення (RF 3): однакова поведінка в кожному дизайні й обох слотах, де вона є
 * (картка пошуку, «Мої ігри»), — спільна `CoverAttachment`.
 */
const CASES: Case[] = [
  ['quest-board game-card', QuestBoardGameCard, 'nri-qb-attachment', cardInputs],
  ['quest-board my-game-item', QuestBoardMyGameItem, 'nri-qb-attachment', itemInputs],
  ['scene game-card', SceneGameCard, 'nri-sc-attachment', cardInputs],
  ['scene my-game-item', SceneMyGameItem, 'nri-sc-attachment', itemInputs],
];

describe.each(CASES)('cover attachment — %s', (_name, component, selector, inputs) => {
  let fixture: ComponentFixture<unknown>;
  let host: HTMLElement;
  let button: HTMLButtonElement;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        // «Дошка»: анімацію відривання вимкнено — клік по аркушу перейшов би одразу.
        {
          provide: ThemeService,
          useValue: {
            uiPrefs: signal({ tearAnimation: true, sendAnimation: false }),
            preloadEffect: () => undefined,
            effectEnabled: () => false,
          },
        },
      ],
    }).compileComponents();
    const router = TestBed.inject(Router);
    navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(component);
    for (const [k, v] of Object.entries(inputs())) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await fixture.whenStable();
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    host = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(selector)!;
    button = host.querySelector('button')!;
  });

  afterEach(() => {
    (fixture.nativeElement as HTMLElement).remove();
    vi.restoreAllMocks();
  });

  const click = (target: Element) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(ev);
    fixture.detectChanges();
    return ev;
  };

  it('is a button named after the game with a decorative lazy image', () => {
    expect(button.getAttribute('aria-label')).toBeTruthy();
    const img = button.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(COVER);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Не всередині посилання на гру — клік по вкладенню не може бути переходом.
    expect(host.closest('a')).toBeNull();
    // Хост позначено для спільного правила карток — дизайн не дописує свій селектор.
    expect(host.hasAttribute('data-card-interactive')).toBe(true);
  });

  it('keyboard: Tab focus only shows the ring; Enter brings it forward, blur sends it back', () => {
    button.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
    expect(host.classList).not.toContain('front');
    // Enter на <button> браузер перетворює на click.
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    click(button);
    expect(host.classList).toContain('front');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.blur();
    fixture.detectChanges();
    expect(host.classList).not.toContain('front');
  });

  it('clicking the attachment toggles it and never opens the game', () => {
    const ev = click(button);
    expect(host.classList).toContain('front');
    expect(ev.defaultPrevented).toBe(false);
    click(host);
    expect(host.classList).not.toContain('front');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a static hover zone sits where the cover rests and toggles it on click', () => {
    const zone = host.querySelector<HTMLElement>('.hover-zone')!;
    // Декоративна, поза кнопкою: керує наведенням, не рухається разом з обкладинкою.
    expect(zone).not.toBeNull();
    expect(zone.getAttribute('aria-hidden')).toBe('true');
    expect(zone.parentElement).toBe(host);
    expect(button.contains(zone)).toBe(false);
    click(zone);
    expect(host.classList).toContain('front');
    click(zone);
    expect(host.classList).not.toContain('front');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Esc sends it back and cancels the hover enlargement until the pointer leaves', () => {
    click(button);
    const hover = vi.spyOn(host, 'matches').mockImplementation((sel) => sel === ':hover');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.classList).not.toContain('front');
    expect(host.classList).toContain('dismissed');
    hover.mockRestore();
    host.dispatchEvent(new MouseEvent('mouseleave'));
    fixture.detectChanges();
    expect(host.classList).not.toContain('dismissed');
  });

  it('a pointer press elsewhere sends it back', () => {
    click(button);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(host.classList).not.toContain('front');
  });

  it('a broken image hides the attachment', () => {
    host.querySelector('img')!.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(host.classList).toContain('failed');
    expect(getComputedStyle(host).display).toBe('none');
  });
});
