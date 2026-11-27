import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import type { SearchGameCardDto } from '@nri/shared';
import { toGameCardVm } from '../../../core/games/game-card.vm';
import { GameOpenedMoment } from '../../moments/game-opened';
import { FallbackGameCard } from './fallback-game-card';

const game = {
  id: 5,
  title: 'Туман над Дніпром',
  summary: null,
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'online',
  city: null,
  nextSessionAt: null,
  nextSessionWindowMinutes: null,
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  kind: 'oneshot',
  language: 'uk',
  status: 'recruiting',
  gmRating: null,
} satisfies SearchGameCardDto;

describe('FallbackGameCard: момент gameOpened', () => {
  const title = async () => {
    TestBed.configureTestingModule({
      imports: [FallbackGameCard],
      providers: [provideRouter([]), provideTranslateService()],
    });
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(FallbackGameCard);
    fixture.componentRef.setInput(
      'game',
      toGameCardVm(game, null, { guest: false, genreKey: () => null, viewMode: 'player' }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('h2 a')!;
  };
  const click = (a: HTMLElement, init: MouseEventInit = {}) =>
    a.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
    );

  it('звичайний клік по назві позначає перехід з картки', async () => {
    const a = await title();
    const fromCard = vi.spyOn(TestBed.inject(GameOpenedMoment), 'fromCard');
    click(a);
    expect(fromCard).toHaveBeenCalledExactlyOnceWith(5);
  });

  it('клік з модифікатором чи середньою кнопкою (нова вкладка) — ні', async () => {
    const a = await title();
    const fromCard = vi.spyOn(TestBed.inject(GameOpenedMoment), 'fromCard');
    click(a, { ctrlKey: true });
    click(a, { button: 1 });
    expect(fromCard).not.toHaveBeenCalled();
  });
});
