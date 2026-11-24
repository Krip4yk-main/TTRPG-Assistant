import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import type { GameCardDto, MeDto } from '@nri/shared';
import { MyGames } from './my-games';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [],
} satisfies MeDto;

function card(id: number, status: GameCardDto['status']): GameCardDto {
  return {
    id,
    title: `Гра ${id}`,
    coverUrl: null,
    system: { id: 1, name: 'D&D 5e' },
    systemOther: null,
    genreId: 1,
    gm: { publicId: 'abcdefghjk', nickname: 'Gandalf', avatarUrl: null },
    format: 'online',
    city: null,
    nextSessionAt: '2027-03-02T17:00:00.000Z',
    freeSlots: 4,
    maxPlayers: 5,
    priceUah: null,
    ageRating: 'none',
    kind: 'oneshot',
    language: 'uk',
    status,
  };
}

describe('MyGames', () => {
  let fixture: ComponentFixture<MyGames>;
  let http: HttpTestingController;
  let el: HTMLElement;
  const open = vi.fn();

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const article = (id: number) => el.querySelector<HTMLElement>(`[data-game-id="${id}"]`)!;
  const actions = (id: number) =>
    Array.from(article(id).querySelectorAll<HTMLElement>('.actions [data-action]')).map(
      (b) => b.dataset['action'],
    );

  beforeEach(async () => {
    open.mockReset();
    await TestBed.configureTestingModule({
      imports: [MyGames],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open } },
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
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MyGames);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http
      .expectOne('/api/games/mine')
      .flush([card(1, 'draft'), card(2, 'recruiting'), card(3, 'started'), card(4, 'finished')]);
    await settle();
  });

  afterEach(() => http.verify());

  it('renders cards with a status badge and status-specific actions', () => {
    expect(article(1).querySelector('.status')!.textContent).toContain('games.status.draft');
    expect(actions(1)).toEqual(['edit', 'publish', 'cancel']);
    expect(actions(2)).toEqual(['edit', 'start', 'cancel']);
    expect(actions(3)).toEqual(['edit', 'finish', 'cancel']);
    expect(actions(4)).toEqual([]);
  });

  it('cancel asks for confirmation and only then POSTs', async () => {
    open.mockReturnValueOnce({ afterClosed: () => of(false) });
    article(2).querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    http.expectNone('/api/games/2/cancel');

    open.mockReturnValueOnce({ afterClosed: () => of(true) });
    article(2).querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await settle();
    const req = http.expectOne('/api/games/2/cancel');
    expect(req.request.method).toBe('POST');
    req.flush({ ...card(2, 'cancelled'), status: 'cancelled' });
    await settle();
    expect(article(2).querySelector('.status')!.textContent).toContain('games.status.cancelled');
    expect(actions(2)).toEqual([]);
  });

  it('a failed transition shows the translated error', async () => {
    open.mockReturnValueOnce({ afterClosed: () => of(true) });
    article(1).querySelector<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle();
    http
      .expectOne('/api/games/1/publish')
      .flush({ error: { code: 'GAME_IN_PAST' } }, { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el.textContent).toContain('errors.GAME_IN_PAST');
  });
});
