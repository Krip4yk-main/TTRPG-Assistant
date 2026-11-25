import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { AdminDeadGameDto, MeDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { SocketService } from '../../../core/realtime/socket.service';
import { AdminDeadGames } from './dead-games';

const me = {
  id: 1,
  publicId: 'abcdefghjk',
  nickname: 'Mod',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'moderator',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true },
  identities: [],
} satisfies MeDto;

const deadGame: AdminDeadGameDto = {
  id: 12,
  title: 'Покинута кампанія',
  status: 'started',
  gm: { publicId: 'gm00000001', nickname: 'Гендальф', role: 'user' },
  publishedAt: '2026-05-01T10:00:00.000Z',
  lastActivityAt: '2026-06-01T10:00:00.000Z',
  deadAt: '2026-09-01T04:00:00.000Z',
  suspiciousAt: null,
};

describe('AdminDeadGames', () => {
  let fixture: ComponentFixture<AdminDeadGames>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const overlay = () => document.querySelector<HTMLElement>('.cdk-overlay-container')!;
  const clearOverlay = () =>
    document.querySelectorAll('.cdk-overlay-container').forEach((c) => (c.innerHTML = ''));
  const typeNote = async (value: string) => {
    const area = overlay().querySelector<HTMLTextAreaElement>('textarea.text')!;
    area.value = value;
    area.dispatchEvent(new Event('input'));
    await settle();
  };
  const gone = (id: number) =>
    vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector(`[data-game="${id}"]`)).toBeNull();
    });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminDeadGames],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AdminDeadGames);
    el = fixture.nativeElement as HTMLElement;
    document.body.appendChild(el);
    await settle();
    const req = http.expectOne((r) => r.url === '/api/admin/dead-games');
    expect(req.request.params.get('kind')).toBe('dead');
    req.flush({ items: [deadGame], nextCursor: null });
    await settle();
  });

  afterEach(() => {
    http.verify();
    el.remove();
    clearOverlay();
  });

  it('lists dead games with the GM, the game link and the dates', () => {
    const item = el.querySelector('[data-game="12"]')!;
    expect(item.querySelector('a[href="/games/12"]')!.textContent).toContain('Покинута кампанія');
    expect(item.textContent).toContain('Гендальф');
    expect(item.textContent).toContain('admin.deadGames.deadAt');
    expect(item.textContent).toContain('games.status.started');
    for (const b of item.querySelectorAll('.actions button')) {
      expect(b.getAttribute('aria-label')).toContain('games.actions.aria');
    }
  });

  it('the «suspicious» filter reloads the list', async () => {
    const toggles = el.querySelectorAll<HTMLButtonElement>('mat-button-toggle button');
    toggles[1]!.click();
    await settle();
    const req = http.expectOne((r) => r.url === '/api/admin/dead-games');
    expect(req.request.params.get('kind')).toBe('suspicious');
    req.flush({
      items: [{ ...deadGame, deadAt: null, suspiciousAt: '2026-11-20T04:00:00.000Z' }],
      nextCursor: null,
    });
    await settle();
    expect(el.querySelector('[data-game="12"]')!.textContent).toContain(
      'admin.deadGames.suspiciousAt',
    );
  });

  it('closing asks for confirmation; cancelling the dialog sends nothing', async () => {
    el.querySelector<HTMLButtonElement>('button.close-game')!.click();
    await settle();
    expect(overlay().querySelector('h2')!.textContent).toContain('admin.deadGames.closeTitle');
    expect(overlay().textContent).toContain('admin.deadGames.closeText');
    [...overlay().querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent!.includes('common.cancel'))!
      .click();
    await settle();
    http.expectNone('/api/admin/dead-games/12/close');
    expect(el.querySelector('[data-game="12"]')).not.toBeNull();
  });

  it('confirmed closing (reason optional) removes the game from the list', async () => {
    el.querySelector<HTMLButtonElement>('button.close-game')!.click();
    await settle();
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    const req = http.expectOne('/api/admin/dead-games/12/close');
    expect(req.request.body).toEqual({});
    req.flush({ ...deadGame, status: 'finished' });
    await gone(12);
    await vi.waitFor(() => expect(document.activeElement).toBe(el.querySelector('.notice-area')));
  });

  it('dismissing sends the kind and the note', async () => {
    el.querySelector<HTMLButtonElement>('button.dismiss')!.click();
    await settle();
    expect(overlay().textContent).toContain('admin.deadGames.dismissText.dead');
    await typeNote('  Майстер у відпустці  ');
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    const req = http.expectOne('/api/admin/dead-games/12/dismiss');
    expect(req.request.body).toEqual({ kind: 'dead', reason: 'Майстер у відпустці' });
    req.flush({ ...deadGame, deadAt: null });
    await gone(12);
  });

  it('a 409 (already handled) removes the game and explains why', async () => {
    el.querySelector<HTMLButtonElement>('button.dismiss')!.click();
    await settle();
    overlay().querySelector<HTMLButtonElement>('button.confirm')!.click();
    await settle();
    http
      .expectOne('/api/admin/dead-games/12/dismiss')
      .flush({ error: { code: 'GAME_INVALID_TRANSITION' } }, { status: 409, statusText: 'C' });
    await gone(12);
    expect(el.textContent).toContain('errors.GAME_INVALID_TRANSITION');
  });
});
