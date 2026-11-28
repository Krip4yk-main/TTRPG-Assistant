import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import type { MeDto } from '@nri/shared';
import { FallbackShell } from './fallback-shell';
import { routes } from '../../../app.routes';
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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  defaultView: 'player',
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
  identities: [],
} satisfies MeDto;

describe('FallbackShell', () => {
  let fixture: ComponentFixture<FallbackShell>;
  let http: HttpTestingController;
  let el: HTMLElement;

  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FallbackShell],
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
    fixture = TestBed.createComponent(FallbackShell);
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

  it('footer links «About» and «Sponsors»', async () => {
    await settle();
    expect(el.querySelector('footer a[href="/about"]')).not.toBeNull();
    expect(el.querySelector('footer a[href="/sponsors"]')?.textContent).toContain('shell.sponsors');
  });
});
