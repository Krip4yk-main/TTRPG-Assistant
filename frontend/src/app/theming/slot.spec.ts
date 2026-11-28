import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MyGameCardDto, ThemeId } from '@nri/shared';
import { toMyGameItemVm } from '../core/games/my-game-item.vm';
import { SocketService } from '../core/realtime/socket.service';
import { Slot } from './slot';
import type { SlotOutputEvent, ThemeSlots } from './slots';
import { THEME_REGISTRY, THEMES, type ThemeDefinition } from './theme.registry';
import { ThemeService } from './theme.service';
import { SCENE_SLOTS } from './themes/scene/slots';

const game: MyGameCardDto = {
  id: 2,
  title: 'Гра 2',
  summary: null,
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'abcdefghjk', nickname: 'Gandalf', avatarUrl: null },
  format: 'online',
  city: null,
  nextSessionAt: null,
  nextSessionWindowMinutes: null,
  startsAt: '2027-03-02T17:00:00.000Z',
  timezone: 'Europe/Kyiv',
  freeSlots: 4,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  kind: 'oneshot',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
  minPlayers: 2,
  memberCount: 1,
  pendingApplications: 3,
  seen: 'seen',
  staleness: 'ok',
  suspicious: false,
};

const vm = (g: MyGameCardDto = game) => toMyGameItemVm(g, { me: null, seen: null });

function registry(load: () => Promise<ThemeSlots>): Record<ThemeId, ThemeDefinition> {
  return {
    'quest-board': { ...THEMES['quest-board'], loadSlots: load },
    'neon-signs': { ...THEMES['neon-signs'], loadSlots: load },
    'holo-market': { ...THEMES['holo-market'], loadSlots: load },
    'night-city': { ...THEMES['night-city'], loadSlots: load },
    dungeon: { ...THEMES.dungeon, loadSlots: load },
    'gothic-gloom': { ...THEMES['gothic-gloom'], loadSlots: load },
    magicpunk: { ...THEMES.magicpunk, loadSlots: load },
    'brass-steam': { ...THEMES['brass-steam'], loadSlots: load },
    'solar-garden': { ...THEMES['solar-garden'], loadSlots: load },
    'painted-city': { ...THEMES['painted-city'], loadSlots: load },
  };
}

describe('nri-slot', () => {
  let fixture: ComponentFixture<Slot>;
  let el: HTMLElement;
  let events: SlotOutputEvent[];

  const setup = async (load: () => Promise<ThemeSlots>) => {
    await TestBed.configureTestingModule({
      imports: [Slot],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: THEME_REGISTRY, useValue: registry(load) },
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject(),
            on: () => new Subject(),
          },
        },
      ],
    }).compileComponents();
    await TestBed.inject(ThemeService).init();
    fixture = TestBed.createComponent(Slot);
    el = fixture.nativeElement as HTMLElement;
    events = [];
    fixture.componentInstance.output.subscribe((e) => events.push(e));
    fixture.componentRef.setInput('name', 'my-game-item');
    fixture.componentRef.setInput('inputs', { item: vm(), busy: false });
    fixture.detectChanges();
    await fixture.whenStable();
  };

  afterEach(() => {
    document.head.querySelectorAll('link#nri-theme-style').forEach((l) => l.remove());
    localStorage.clear();
  });

  it("renders the design's component with inputs and forwards its outputs", async () => {
    await setup(() => Promise.resolve(SCENE_SLOTS));
    const item = el.querySelector('nri-sc-my-game-item')!;
    expect(item).not.toBeNull();
    expect(item.querySelector('.pending-count')!.getAttribute('data-count')).toBe('3');
    // Текст шапки-запрошення для декору дизайну (ключ без перекладу в тесті — сам ключ).
    expect(item.querySelector('.panel')!.getAttribute('data-invite')).toBe('scene.invite');
    expect(item.querySelector('.panel')!.getAttribute('data-telegram')).toBe('scene.telegram');

    el.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    expect(events).toEqual([{ name: 'action', value: { action: 'cancel' } }]);
  });

  it('input changes update the same component instance', async () => {
    await setup(() => Promise.resolve(SCENE_SLOTS));
    const before = el.querySelector('nri-sc-my-game-item');
    fixture.componentRef.setInput('inputs', {
      item: vm({ ...game, status: 'started' }),
      busy: true,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelector('nri-sc-my-game-item')).toBe(before);
    expect(el.querySelector('.status')!.getAttribute('data-status')).toBe('started');
    expect(el.querySelector<HTMLButtonElement>('[data-action="finish"]')!.disabled).toBe(true);
  });

  it('a failed design chunk renders the plain fallback, which still works (RF 3)', async () => {
    await setup(() => Promise.reject(new Error('ChunkLoadError')));
    expect(el.querySelector('nri-sc-my-game-item')).toBeNull();
    expect(el.querySelector('nri-fallback-my-game-item')).not.toBeNull();
    expect(el.textContent).toContain('Гра 2');
    const actions = Array.from(el.querySelectorAll<HTMLElement>('[data-action]')).map(
      (a) => a.dataset['action'],
    );
    expect(actions).toEqual(['start', 'edit', 'cancel']);
    el.querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
    expect(events).toEqual([{ name: 'action', value: { action: 'start' } }]);
  });
});
