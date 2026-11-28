import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import type { DebugElement, Type } from '@angular/core';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import type { MyGameCardDto, SearchGameCardDto } from '@nri/shared';
import uk from '../../assets/i18n/uk.json';
import type { ThemeSlots } from './slots';
import { SCENE_SLOTS } from './themes/scene/slots';
import { QUEST_BOARD_SLOTS } from './themes/quest-board/slots';
import {
  toGameCardVm,
  type BadgeVm,
  type FullGameCardVm,
  type GameCardVm,
} from '../core/games/game-card.vm';
import {
  toMyGameItemVm,
  type MyGameActionEvent,
  type MyGameItemVm,
} from '../core/games/my-game-item.vm';
import { browserZone } from '../core/i18n/dates';

/**
 * Спільний контракт слотів «картка гри» й «рядок моєї гри» для всіх дизайнів (RF 4 —
 * функціональний паритет; RF 5 — довгі дані не ламають розкладку й не ховають дії).
 * Перевірки — за видимим текстом і посиланнями, а не за класами конкретного дизайну.
 */
const DESIGNS: [string, ThemeSlots][] = [
  ['quest-board', QUEST_BOARD_SLOTS],
  ['night-city', SCENE_SLOTS],
];

const game: SearchGameCardDto = {
  id: 5,
  title: 'Туман над Дніпром',
  summary: 'Готичний жах у тумані над Дніпром.',
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'offline',
  city: 'Київ',
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  nextSessionWindowMinutes: null,
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: 150,
  ageRating: '18+',
  kind: 'campaign',
  language: 'uk',
  status: 'started',
  gmRating: 4.25,
  fit: 'full',
};

function myGame(patch: Partial<MyGameCardDto> = {}): MyGameCardDto {
  return {
    ...game,
    fit: undefined,
    status: 'recruiting',
    minPlayers: 2,
    memberCount: 1,
    pendingApplications: 3,
    seen: 'seen',
    staleness: 'ok',
    suspicious: false,
    ...patch,
  } as MyGameCardDto;
}

const COVER = 'https://example.com/cover.png';

/** Обкладинка (RF 3): картинка з адресою обкладинки в кнопці, названій за грою. */
function expectCover(el: HTMLElement): void {
  const img = el.querySelector<HTMLImageElement>(`img[src="${COVER}"]`);
  expect(img).not.toBeNull();
  expect(img!.getAttribute('alt')).toBe('');
  expect(img!.closest('button')!.getAttribute('aria-label')).toContain('Туман над Дніпром');
}

const LONG_TITLE = 'Довга-назва-без-пробілів-'.repeat(5).slice(0, 120);
const LONG_NICK = 'Нікнейм_на_сорок_символів_без_пробілів_X'.slice(0, 40);

describe.each(DESIGNS)('slot contract — design «%s»', (_name, slots) => {
  beforeEach(async () => {
    vi.spyOn(browserZone, 'get').mockReturnValue('Europe/Kyiv');
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService({ lang: 'uk' }),
      ],
    }).compileComponents();
    const t = TestBed.inject(TranslateService);
    t.setTranslation('uk', uk);
    t.use('uk');
  });

  afterEach(() => vi.restoreAllMocks());

  const mount = async (component: Type<unknown>, inputs: Record<string, unknown>) => {
    const fixture = TestBed.createComponent(component);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  };

  /** Повні тексти підказок обрізаних рядків (RF 5: обрізане видно повністю при наведенні). */
  const tooltips = (root: DebugElement): string[] =>
    root.queryAll(By.directive(MatTooltip)).map((d) => d.injector.get(MatTooltip).message);

  const cardVm = (g: object): GameCardVm =>
    toGameCardVm(g as SearchGameCardDto, null, { guest: false, genreKey: () => null });

  describe('game-card', () => {
    it('shows title, system, schedule, seats, price, age, status, link and GM signature', async () => {
      const el = (await mount(slots['game-card'], { game: cardVm(game) })).nativeElement;
      const text = el.textContent as string;
      expect(text).toContain('Туман над Дніпром');
      expect(text).toContain('Готичний жах у тумані над Дніпром.'); // короткий опис
      expect(text).toContain('D&D 5e');
      expect(text).toContain('Київ');
      expect(text).toContain('19:00'); // найближча сесія
      expect(text).toContain('3 з 5 зайняті'); // вид гравця — зайняті місця
      expect(text).toContain('150 грн');
      expect(text).toContain('18+');
      expect(text).toContain('Триває');
      expect(text).toContain('Підходить');
      expect(el.querySelector('a[href="/games/5"]')).not.toBeNull();
      expect(el.querySelector('a[href="/users/zzzzzzzzzz"]')!.textContent).toContain('Gandalf');
      expect(text).toContain('4,3');
    });

    it('short description: shown in full (tooltip when clamped); absent — no empty block', async () => {
      const long = 'Довгий опис кампанії, що не вміщається в кілька рядків. '.repeat(4).trim();
      const fixture = await mount(slots['game-card'], { game: cardVm({ ...game, summary: long }) });
      expect(fixture.nativeElement.textContent).toContain(long);
      expect(tooltips(fixture.debugElement)).toContain(long);
      const none = await mount(slots['game-card'], { game: cardVm({ ...game, summary: null }) });
      expect(none.nativeElement.textContent).not.toContain('Готичний жах');
    });

    it('cover: shown as a named button with the image; no cover — no image', async () => {
      const el = (await mount(slots['game-card'], { game: cardVm({ ...game, coverUrl: COVER }) }))
        .nativeElement;
      expectCover(el);
      const none = (await mount(slots['game-card'], { game: cardVm(game) })).nativeElement;
      expect(none.querySelector('img')).toBeNull();
    });

    it('seats follow the view: players see taken, GMs — free', async () => {
      const gmVm = toGameCardVm(game, null, {
        guest: false,
        genreKey: () => null,
        viewMode: 'gm',
      });
      const gmText = (await mount(slots['game-card'], { game: gmVm })).nativeElement.textContent;
      expect(gmText).toContain('2 з 5 вільні');
      expect(gmText).not.toContain('зайняті');
    });

    it('free game says so; no rating yet is stated', async () => {
      const vm = cardVm({ ...game, priceUah: null, gmRating: null });
      const text = (await mount(slots['game-card'], { game: vm })).nativeElement.textContent;
      expect(text).toMatch(/без плати/);
      expect(text).toContain('ще немає рейтингу');
    });

    it('finished game hides the schedule and seats', async () => {
      const vm = cardVm({ ...game, status: 'finished' });
      const text = (await mount(slots['game-card'], { game: vm })).nativeElement.textContent;
      expect(text).toContain('Завершена');
      expect(text).not.toContain('19:00');
      expect(text).not.toContain('вільні');
      expect(text).not.toContain('зайняті');
    });

    it('restricted card: title, age, GM, login invite — and nothing else', async () => {
      const vm = toGameCardVm(
        {
          id: 6,
          title: 'Темна вежа',
          gm: game.gm,
          ageRating: '21+',
          restricted: true,
          description: 'SECRET',
          city: 'Секретне місто',
        } as never,
        null,
        { guest: true, genreKey: () => null },
      );
      const el = (await mount(slots['game-card'], { game: vm })).nativeElement;
      const text = el.textContent as string;
      expect(text).toContain('Темна вежа');
      expect(text).toContain('21+');
      expect(text).toContain('Gandalf');
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('Секретне місто');
      expect(el.querySelector('img')).toBeNull();
      expect(el.querySelector('a[href^="/login"]')).not.toBeNull();
    });

    it('long data (RF 5): 120-char title, 40-char nick, no cover, no rating, 10+ badges', async () => {
      const base = cardVm({ ...game, title: LONG_TITLE, coverUrl: null, gmRating: null });
      const extra: BadgeVm[] = Array.from({ length: 10 }, (_, i) => ({
        kind: i % 2 ? 'status' : 'age',
        value: 'x',
        labelKey: `Позначка ${i}`,
        icon: null,
      }));
      const vm: FullGameCardVm = {
        ...(base as FullGameCardVm),
        badges: [...base.badges, ...extra],
        gm: { ...base.gm, nickname: LONG_NICK, rating: null },
      };
      const fixture = await mount(slots['game-card'], { game: vm });
      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain(LONG_TITLE);
      expect(el.textContent).toContain(LONG_NICK);
      expect(el.textContent).toContain('Позначка 9');
      // Посилання заявки (на гру) лишається видимим.
      const link = el.querySelector<HTMLElement>('a[href="/games/5"]')!;
      expect(getComputedStyle(link).display).not.toBe('none');
      expect(getComputedStyle(link).visibility).not.toBe('hidden');
      // Немає горизонтального переповнення (у браузері — реальна розкладка; jsdom — 0 ≤ 0).
      const card = el.querySelector<HTMLElement>('article')!;
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      // Розмір картки не залежить від даних: довгі назва й нік обрізаються (overflow: hidden),
      // а повний текст — у підказці.
      const titleEl = el.querySelector<HTMLElement>('h2 a')!;
      expect(getComputedStyle(titleEl).overflow).toBe('hidden');
      expect(tooltips(fixture.debugElement)).toEqual(
        expect.arrayContaining([LONG_TITLE, LONG_NICK]),
      );
    });
  });

  describe('my-game-item', () => {
    const itemVm = (g: MyGameCardDto): MyGameItemVm =>
      toMyGameItemVm(g, { me: null, seen: 'updated' });

    it('cover: shown as a named button with the image; no cover — no image', async () => {
      const el: HTMLElement = (
        await mount(slots['my-game-item'], {
          item: itemVm(myGame({ coverUrl: COVER })),
          busy: false,
        })
      ).nativeElement;
      expectCover(el);
      const none: HTMLElement = (
        await mount(slots['my-game-item'], { item: itemVm(myGame()), busy: false })
      ).nativeElement;
      expect(none.querySelector('img')).toBeNull();
    });

    it('shows title, status, schedule, seats, applications and all GM actions', async () => {
      const fixture = await mount(slots['my-game-item'], {
        item: itemVm(myGame()),
        busy: false,
      });
      const el: HTMLElement = fixture.nativeElement;
      const text = el.textContent as string;
      expect(text).toContain('Туман над Дніпром');
      expect(text).toContain('Набір гравців');
      expect(text).toContain('D&D 5e');
      expect(text).toContain('19:00');
      expect(text).toContain('Оновлено');
      expect(text).toContain('3 з 5 зайняті'); // вид гравця — зайняті місця
      expect(el.querySelector('a[href="/games/5/applications"]')).not.toBeNull();
      expect(text).toContain('Нових: 3');
      expect(el.querySelector('a[href="/games/5/edit"]')).not.toBeNull();
      for (const action of ['start', 'cancel']) {
        expect(el.querySelector(`button[data-action="${action}"]`)).not.toBeNull();
      }

      const emitted: MyGameActionEvent[] = [];
      (
        fixture.componentInstance as {
          action: { subscribe(f: (e: MyGameActionEvent) => void): void };
        }
      ).action.subscribe((e) => emitted.push(e));
      el.querySelector<HTMLButtonElement>('button[data-action="start"]')!.click();
      expect(emitted).toEqual([{ action: 'start' }]);
    });

    it('seats in the GM view: free of capacity', async () => {
      const item = toMyGameItemVm(myGame(), { me: null, seen: null, viewMode: 'gm' });
      const text = (await mount(slots['my-game-item'], { item, busy: false })).nativeElement
        .textContent as string;
      expect(text).toContain('2 з 5 вільні');
      expect(text).not.toContain('зайняті');
    });

    it('stale/dead/suspicious flags with «All ok» and «Close» actions', async () => {
      for (const staleness of ['stale', 'dead'] as const) {
        const el: HTMLElement = (
          await mount(slots['my-game-item'], {
            item: itemVm(myGame({ staleness, suspicious: true })),
            busy: false,
          })
        ).nativeElement;
        const text = el.textContent as string;
        expect(text).toContain(staleness === 'stale' ? 'Давно не проводилась' : 'Мертва');
        expect(text).toContain('Підозріла');
        expect(el.querySelector('button[data-action="still-alive"]')).not.toBeNull();
        expect(el.querySelector('button[data-action="close-dead"]')).not.toBeNull();
      }
    });

    it('busy disables action buttons', async () => {
      const el: HTMLElement = (
        await mount(slots['my-game-item'], { item: itemVm(myGame()), busy: true })
      ).nativeElement;
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button[data-action]'));
      expect(buttons.length).toBeGreaterThan(0);
      expect(buttons.every((b) => b.disabled)).toBe(true);
    });

    it('long data (RF 5): long title keeps every action visible, no overflow', async () => {
      const fixture = await mount(slots['my-game-item'], {
        item: itemVm(myGame({ title: LONG_TITLE, staleness: 'dead', suspicious: true })),
        busy: false,
      });
      const el: HTMLElement = fixture.nativeElement;
      expect(el.textContent).toContain(LONG_TITLE);
      const actions = Array.from(el.querySelectorAll<HTMLElement>('[data-action]'));
      expect(actions.map((a) => a.getAttribute('data-action'))).toEqual([
        'still-alive',
        'edit',
        'start',
        'pause',
        'close-dead',
        'cancel',
      ]);
      for (const a of actions) expect(getComputedStyle(a).display).not.toBe('none');
      const card = el.querySelector<HTMLElement>('article')!;
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
      // Назва обрізається «…», повна — у підказці.
      expect(getComputedStyle(el.querySelector('h2')!).overflow).toBe('hidden');
      expect(tooltips(fixture.debugElement)).toContain(LONG_TITLE);
    });
  });
});
