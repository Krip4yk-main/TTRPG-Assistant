import type { SessionLostReason } from '../realtime/socket.service';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth.interceptor';
import { AuthStore } from '../auth/auth.store';
import { SocketService } from '../realtime/socket.service';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthStore;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject<SessionLostReason>(),
          },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthStore);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/account');
    router.navigated = true;
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true) as unknown as ReturnType<
      typeof vi.fn
    >;
    auth.setMe({
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
      avatarSource: 'auto',
      customAvatarUrl: null,
      avatarOptions: [],
      identities: [],
    });
  });

  afterEach(() => ctrl.verify());

  const fail = async (method: 'GET' | 'POST', url: string, status: number) => {
    const req$ = method === 'GET' ? http.get(url) : http.post(url, {});
    const done = firstValueFrom(req$).catch(() => undefined);
    ctrl.expectOne(url).flush({ error: { code: 'X' } }, { status, statusText: 'x' });
    await done;
  };

  it('401 на API-запит → очищає стан і веде на /login з returnTo', async () => {
    await fail('POST', '/api/me/complete-profile', 401);
    expect(auth.me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { error: 'UNAUTHENTICATED', returnTo: '/account' },
    });
  });

  it('401 на початковий GET /api/me не перенаправляє', async () => {
    await fail('GET', '/api/me', 401);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('401 на ендпоінти входу не перенаправляє', async () => {
    await fail('POST', '/api/auth/dev-login', 401);
    await fail('POST', '/api/auth/telegram', 401);
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.me()).not.toBeNull();
  });

  it('401 на апеляцію заблокованого не перенаправляє', async () => {
    await fail('POST', '/api/appeals', 401);
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.me()).not.toBeNull();
  });

  it('403 ACCOUNT_BANNED (бан посеред сесії) → гість, pendingBan і /login без токена в адресі', async () => {
    const done = firstValueFrom(http.post('/api/games', {})).catch(() => undefined);
    ctrl
      .expectOne('/api/games')
      .flush(
        { error: { code: 'ACCOUNT_BANNED', details: { appealToken: 'tok', appealSent: false } } },
        { status: 403, statusText: 'Forbidden' },
      );
    await done;
    expect(auth.me()).toBeNull();
    expect(auth.pendingBan()).toEqual({ appealToken: 'tok', appealSent: false });
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { error: 'ACCOUNT_BANNED', returnTo: '/account' },
    });
  });

  it('5xx не розлогінює', async () => {
    await fail('POST', '/api/me/telegram-link-token', 500);
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.me()).not.toBeNull();
  });
});
