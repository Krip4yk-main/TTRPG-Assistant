import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import type { GameCardDto, MyApplicationDto } from '@nri/shared';
import { MyApplications } from './my-applications';
import { ConfirmDialog } from '../../../shared/confirm-dialog/confirm-dialog';
import { SocketService } from '../../../core/realtime/socket.service';

const card: GameCardDto = {
  id: 7,
  title: 'Туман над Дніпром',
  coverUrl: null,
  system: { id: 1, name: 'D&D 5e' },
  systemOther: null,
  genreId: 1,
  gm: { publicId: 'zzzzzzzzzz', nickname: 'Gandalf', avatarUrl: null },
  format: 'online',
  city: null,
  nextSessionAt: '2027-03-02T17:00:00.000Z',
  timezone: 'Europe/Kyiv',
  freeSlots: 2,
  maxPlayers: 5,
  priceUah: null,
  ageRating: 'none',
  kind: 'campaign',
  language: 'uk',
  status: 'recruiting',
};

const base: MyApplicationDto = {
  id: 1,
  gameId: 7,
  status: 'pending',
  message: 'Привіт, майстре',
  answers: [],
  constraints: [
    { id: 'aaaaaaaa', text: 'Без павуків', response: 'partial', comment: 'Лише згадки' },
    { id: 'bbbbbbbb', text: 'До 22:00', response: null, comment: null },
  ],
  cancelReason: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  decidedAt: null,
  game: card,
  seen: 'seen',
};

const list: MyApplicationDto[] = [
  base,
  {
    ...base,
    id: 2,
    gameId: 8,
    status: 'cancelled',
    cancelReason: 'age_rating',
    constraints: [],
    message: null,
    decidedAt: '2026-11-21T10:00:00.000Z',
    game: {
      id: 8,
      title: 'Темна вежа',
      gm: card.gm,
      ageRating: '18+',
      restricted: true,
    },
  },
  {
    ...base,
    id: 3,
    gameId: 9,
    status: 'approved',
    constraints: [],
    game: { ...card, id: 9, title: 'Затверджена' },
  },
];

describe('MyApplications', () => {
  let fixture: ComponentFixture<MyApplications>;
  let http: HttpTestingController;
  let el: HTMLElement;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let pings: Subject<unknown>;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  async function create(items: MyApplicationDto[] = list) {
    dialogOpen = vi.fn();
    pings = new Subject();
    await TestBed.configureTestingModule({
      imports: [MyApplications],
      providers: [
        {
          provide: SocketService,
          useValue: {
            on: (ev: string) => (ev === 'game.changed' ? pings : new Subject()),
            connected$: new Subject(),
            isConnected: () => false,
            sessionLost$: new Subject(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            request: vi.fn(),
            send: vi.fn(),
          },
        },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        { provide: MatDialog, useValue: { open: dialogOpen } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MyApplications);
    el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/me/applications').flush(items);
    await settle();
  }

  afterEach(() => http.verify());

  const group = (status: string) => el.querySelector(`section[data-status="${status}"]`);
  const card$ = (id: number) => el.querySelector<HTMLElement>(`[data-application-id="${id}"]`)!;

  it('groups applications by status, pending first', async () => {
    await create();
    const groups = [...el.querySelectorAll('section[data-status]')].map((s) =>
      s.getAttribute('data-status'),
    );
    expect(groups).toEqual(['pending', 'approved', 'cancelled']);
    expect(group('pending')!.textContent).toContain('Туман над Дніпром');
    expect(group('approved')!.textContent).toContain('Затверджена');
    expect(card$(1).querySelector('a.game-link')!.getAttribute('href')).toBe('/games/7');
  });

  it('shows the cancel reason and a restricted game without details', async () => {
    await create();
    const c = card$(2);
    expect(c.textContent).toContain('games.applications.cancelReason.age_rating');
    expect(c.textContent).toContain('Темна вежа');
    expect(c.textContent).toContain('games.ageRating.18+');
  });

  it('shows the GM responses to my constraints', async () => {
    await create();
    const items = card$(1).querySelectorAll('.constraints li');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Без павуків');
    expect(items[0]!.textContent).toContain('games.applications.constraintResponse.partial');
    expect(items[0]!.textContent).toContain('Лише згадки');
    expect(items[1]!.textContent).toContain('games.applications.constraintResponse.none');
  });

  it('withdraw: no request without confirmation; DELETE after it, card moves to withdrawn', async () => {
    await create();
    const button = () => card$(1).querySelector<HTMLButtonElement>('button.withdraw')!;
    expect(card$(3).querySelector('button.withdraw')).toBeNull();

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(false) });
    button().click();
    await settle();
    expect(dialogOpen).toHaveBeenCalledWith(ConfirmDialog, expect.anything());
    http.expectNone('/api/applications/1');

    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(true) });
    button().click();
    await settle();
    const req = http.expectOne('/api/applications/1');
    expect(req.request.method).toBe('DELETE');
    const dto: Partial<MyApplicationDto> = { ...base, status: 'withdrawn' };
    delete dto.game;
    req.flush({ ...dto, decidedAt: '2026-11-25T10:00:00.000Z' });
    await settle();
    expect(group('pending')).toBeNull();
    expect(group('withdrawn')!.textContent).toContain('Туман над Дніпром');
    expect(el.textContent).toContain('games.applications.my.withdrawn');
  });

  it('withdraw conflict: shows the error and silently reloads the list', async () => {
    await create();
    dialogOpen.mockReturnValueOnce({ afterClosed: () => of(true) });
    card$(1).querySelector<HTMLButtonElement>('button.withdraw')!.click();
    await settle();
    http
      .expectOne('/api/applications/1')
      .flush({ error: { code: 'APPLICATION_CLOSED' } }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el.textContent).toContain('errors.APPLICATION_CLOSED');
    http.expectOne('/api/me/applications').flush([{ ...base, status: 'approved' }]);
    await settle();
    expect(group('pending')).toBeNull();
    expect(group('approved')).not.toBeNull();
    expect(el.querySelector('[role="status"]')?.textContent ?? '').not.toContain('common.loading');
  });

  it('empty list shows a call to action', async () => {
    await create([]);
    expect(el.textContent).toContain('games.applications.my.empty');
    expect(el.querySelector('a[href="/"]')).not.toBeNull();
  });

  describe('live updates and badges', () => {
    const banner = () => el.querySelector<HTMLElement>('nri-update-banner .banner');

    it('an applications ping shows the banner; refresh re-reads and highlights changed cards', async () => {
      await create();
      expect(banner()).toBeNull();
      pings.next({ gameId: 7, scope: 'sessions' });
      await settle();
      expect(banner()).toBeNull();
      pings.next({ gameId: 7, scope: 'applications' });
      await settle();
      expect(banner()).not.toBeNull();
      http.expectNone('/api/me/applications');
      banner()!.querySelector<HTMLButtonElement>('button.refresh')!.click();
      await settle();
      http
        .expectOne('/api/me/applications')
        .flush(list.map((a) => (a.id === 1 ? { ...a, status: 'rejected' as const } : a)));
      await settle();
      await settle();
      expect(card$(1).classList).toContain('nri-flash');
      expect(card$(3).classList).not.toContain('nri-flash');
      expect(banner()).toBeNull();
    });

    it('a failed refresh keeps the list and the banner', async () => {
      await create();
      pings.next({ gameId: 7, scope: 'applications' });
      await settle();
      banner()!.querySelector<HTMLButtonElement>('button.refresh')!.click();
      await settle();
      http
        .expectOne('/api/me/applications')
        .flush(null, { status: 500, statusText: 'Server Error' });
      await settle();
      await settle();
      expect(card$(1)).not.toBeNull();
      expect(banner()).not.toBeNull();
    });

    it('withdraw quiets only applications pings', async () => {
      await create();
      dialogOpen.mockReturnValueOnce({ afterClosed: () => of(true) });
      card$(1).querySelector<HTMLButtonElement>('button.withdraw')!.click();
      await settle();
      pings.next({ gameId: 7, scope: 'applications' });
      await settle();
      expect(banner()).toBeNull();
      http.expectOne('/api/applications/1').flush({ ...list[0], status: 'withdrawn' });
      await settle();
    });

    it('shows «updated» badges and marks them viewed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await create(list.map((a) => (a.id === 3 ? { ...a, seen: 'updated' as const } : a)));
        expect(card$(3).querySelector('.nri-seen-badge')!.textContent).toContain(
          'live.badge.updated',
        );
        expect(card$(1).querySelector('.nri-seen-badge')).toBeNull();
        vi.runOnlyPendingTimers();
        const req = http.expectOne('/api/me/views');
        expect(req.request.body).toEqual({ entityType: 'application', ids: [3] });
        req.flush(null);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
