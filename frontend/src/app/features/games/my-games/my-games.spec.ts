import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import type { MeDto, MyGameCardDto } from '@nri/shared';
import { MyGames } from './my-games';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { ViewsService } from '../../../core/views/views.service';

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

function card(id: number, status: MyGameCardDto['status']): MyGameCardDto {
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
    timezone: 'Europe/Kyiv',
    freeSlots: 4,
    maxPlayers: 5,
    priceUah: null,
    ageRating: 'none',
    kind: 'oneshot',
    language: 'uk',
    status,
    gmRating: null,
    minPlayers: 2,
    memberCount: 1,
    pendingApplications: 0,
    seen: 'seen',
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
      .flush([
        card(1, 'draft'),
        { ...card(2, 'recruiting'), pendingApplications: 3 },
        { ...card(3, 'started'), memberCount: 2, seen: 'updated' },
        card(4, 'finished'),
        { ...card(5, 'recruiting'), memberCount: 2 },
      ]);
    await settle();
  });

  afterEach(() => {
    // Позначення переглянутим — відкладене; надсилаємо чергу, щоб не текло між тестами.
    TestBed.inject(ViewsService).flush();
    http.match('/api/me/views').forEach((r) => r.flush(null));
    http.verify();
  });

  it('shows the «updated» badge and marks the game viewed', () => {
    expect(article(3).querySelector('.nri-seen-badge')!.textContent).toContain(
      'live.badge.updated',
    );
    expect(article(2).querySelector('.nri-seen-badge')).toBeNull();
    TestBed.inject(ViewsService).flush();
    const req = http.expectOne('/api/me/views');
    expect(req.request.body).toEqual({ entityType: 'game', ids: [3] });
    req.flush(null);
  });

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
    // Лічильники картки (учасники, нові заявки) беремо з сервера після переходу.
    http.expectOne('/api/games/mine').flush([card(2, 'cancelled')]);
    await settle();
    expect(article(2).querySelector('.pending-count')).toBeNull();
    expect(article(1)).toBeNull();
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

  it('shows the number of new applications with a link to the applications page', () => {
    const link = article(2).querySelector<HTMLAnchorElement>('a.applications-link')!;
    expect(link.getAttribute('href')).toBe('/games/2/applications');
    expect(link.textContent).toContain('games.my.applications');
    expect(article(2).querySelector('.pending-count')!.getAttribute('data-count')).toBe('3');
    // Чернетка заявок не приймає — посилання немає; без нових заявок — без лічильника.
    expect(article(1).querySelector('a.applications-link')).toBeNull();
    expect(article(3).querySelector('.pending-count')).toBeNull();
  });

  it('start below the minimum asks «start anyway?» before calling the API', async () => {
    open.mockReturnValueOnce({ afterClosed: () => of(false) });
    article(2).querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
    await settle();
    expect(open.mock.calls[0]![1].data).toMatchObject({
      title: 'games.confirm.startBelowMin.title',
      text: 'games.confirm.startBelowMin.text',
    });
    http.expectNone('/api/games/2/start');
  });

  it('start with enough members uses the regular confirmation', async () => {
    open.mockReturnValueOnce({ afterClosed: () => of(true) });
    article(5).querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
    await settle();
    expect(open.mock.calls[0]![1].data.title).toBe('games.confirm.start.title');
    http.expectOne('/api/games/5/start').flush({ ...card(5, 'started'), status: 'started' });
    await settle();
    expect(el.textContent).toContain('games.my.done.start');
    http.expectOne('/api/games/mine').flush([{ ...card(5, 'started'), memberCount: 2 }]);
    await settle();
  });
});
