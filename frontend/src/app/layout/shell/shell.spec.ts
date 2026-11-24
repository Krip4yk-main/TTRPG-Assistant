import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { Shell } from './shell';
import { routes } from '../../app.routes';
import { AuthStore } from '../../core/auth/auth.store';
import { ViewModeStore } from '../../core/view-mode/view-mode.store';
import { SocketService } from '../../core/realtime/socket.service';

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

describe('Shell home by view mode', () => {
  let fixture: ComponentFixture<Shell>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Shell],
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
            sessionLost$: new Subject(),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(AuthStore).setMe(me);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Shell);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
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
  });
});
