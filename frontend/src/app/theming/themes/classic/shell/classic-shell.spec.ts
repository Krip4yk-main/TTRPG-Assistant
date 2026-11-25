import { ComponentFixture, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { ClassicShell } from './classic-shell';
import { routes } from '../../../../app.routes';
import { AuthStore } from '../../../../core/auth/auth.store';
import { ViewModeStore } from '../../../../core/view-mode/view-mode.store';
import { SocketService } from '../../../../core/realtime/socket.service';

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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true },
  identities: [],
} satisfies MeDto;

describe('ClassicShell (slot «shell»): home by view mode', () => {
  let fixture: ComponentFixture<ClassicShell>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClassicShell],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes, withComponentInputBinding()),
        provideTranslateService(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            on: () => new Subject(),
            connected$: new Subject(),
            isConnected: () => false,
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ClassicShell);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    // Дзвіночок сповіщень тягне лічильник непрочитаних для активного користувача.
    http.match('/api/me/notifications/unread-count').forEach((r) => r.flush({ count: 0 }));
    // «Оцінити» (окремий відкладений блок) тягне список відкритих оцінок.
    http.match('/api/me/ratings/pending').forEach((r) => r.flush([]));
    // Банер санкцій (відкладений блок) тягне мої чинні санкції.
    http.match('/api/me/sanctions').forEach((r) => r.flush([]));
    http.verify();
    localStorage.clear();
  });

  it('GM view renders MyGames on /', async () => {
    TestBed.inject(ViewModeStore).setMode('gm');
    await TestBed.inject(Router).navigateByUrl('/');
    await settle();
    http.expectOne('/api/games/mine').flush([]);
    await settle();
    expect(el.querySelector('nri-my-games')).not.toBeNull();
    expect(el.querySelector('nri-search-page')).toBeNull();
  });

  it('player view renders the game search on /', async () => {
    TestBed.inject(ViewModeStore).setMode('player');
    await TestBed.inject(Router).navigateByUrl('/');
    await settle();
    http.expectOne('/api/catalog').flush({ systems: [], genres: [], contentWarnings: [] });
    http
      .expectOne('/api/me/availability')
      .flush({ timezone: 'Europe/Kyiv', slots: [], busyDates: [] });
    await settle();
    http.expectOne('/api/games/search').flush({ items: [], nextCursor: null });
    await settle();
    expect(el.querySelector('nri-search-page')).not.toBeNull();
    expect(el.querySelector('nri-my-games')).toBeNull();
  });

  it('GM view shows "My games" and "New game" links in the toolbar', async () => {
    TestBed.inject(ViewModeStore).setMode('gm');
    await settle();
    expect(el.querySelector('a[href="/my-games"]')).not.toBeNull();
    expect(el.querySelector('a[href="/games/new"]')).not.toBeNull();
    expect(el.querySelector('a[href="/my-applications"]')).toBeNull();
  });

  it('player view shows the "My applications" link', async () => {
    TestBed.inject(ViewModeStore).setMode('player');
    await settle();
    expect(el.querySelector('a[href="/my-applications"]')).not.toBeNull();
    expect(el.querySelector('a[href="/my-games"]')).toBeNull();
  });

  it('active user gets the notification bell (deferred chunk, reserved placeholder)', async () => {
    await settle();
    // Перший відкладений блок — «Оцінити», другий — дзвіночок.
    const [, block] = await fixture.getDeferBlocks();
    await block!.render(DeferBlockState.Placeholder);
    expect(el.querySelector('.bell-placeholder')).not.toBeNull();
    await block!.render(DeferBlockState.Complete);
    await settle();
    expect(el.querySelector('nri-notification-bell button.bell')).not.toBeNull();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 0 });
  });

  it('/my-applications renders the page', async () => {
    TestBed.inject(ViewModeStore).setMode('player');
    await TestBed.inject(Router).navigateByUrl('/my-applications');
    await settle();
    http.expectOne('/api/me/applications').flush([]);
    await settle();
    expect(el.querySelector('nri-my-applications')).not.toBeNull();
  });
});
