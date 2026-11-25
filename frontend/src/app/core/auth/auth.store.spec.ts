import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NavigationEnd, Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import type { SessionLostReason } from '../realtime/socket.service';
import { AuthStore } from './auth.store';
import { SocketService } from '../realtime/socket.service';
import type { MeDto } from '@nri/shared';

const me = (over: Partial<MeDto> = {}): MeDto => ({
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
  identities: [{ provider: 'dev', displayName: 'Gandalf' }],
  ...over,
});

describe('AuthStore', () => {
  let store: AuthStore;
  let http: HttpTestingController;
  const lost$ = new Subject<SessionLostReason>();
  const socket = { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(), sessionLost$: lost$ };
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: SocketService, useValue: socket },
      ],
    });
    store = TestBed.inject(AuthStore);
    http = TestBed.inject(HttpTestingController);
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/account');
    router.navigated = true;
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true) as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('load() з 403 ACCOUNT_BANNED → гість, pendingBan, /login після початкової навігації', async () => {
    const router = TestBed.inject(Router);
    router.navigated = false;
    const done = store.load();
    http
      .expectOne('/api/me')
      .flush(
        { error: { code: 'ACCOUNT_BANNED', details: { appealToken: 'tok', appealSent: false } } },
        { status: 403, statusText: 'Forbidden' },
      );
    await done;
    expect(store.me()).toBeNull();
    expect(store.isUnknown()).toBe(false);
    expect(store.pendingBan()).toEqual({ appealToken: 'tok', appealSent: false });
    // Початкова навігація ще не завершилася — чекаємо на неї.
    expect(navigate).not.toHaveBeenCalled();
    router.navigated = true;
    (router.events as unknown as Subject<unknown>).next(
      new NavigationEnd(1, '/account', '/account'),
    );
    expect(navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { error: 'ACCOUNT_BANNED', returnTo: '/account' },
    });
  });

  it('load() з відповіддю 401 → гість', async () => {
    const done = store.load();
    http
      .expectOne('/api/me')
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'Unauthorized' });
    await done;

    expect(store.me()).toBeNull();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.isPending()).toBe(false);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("load() з status:'pending' → isPending, сокет не підключається", async () => {
    const done = store.load();
    http.expectOne('/api/me').flush(me({ status: 'pending', nickname: null, birthDate: null }));
    await done;

    expect(store.isAuthenticated()).toBe(true);
    expect(store.isPending()).toBe(true);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('load() з активним користувачем → підключає сокет', async () => {
    const done = store.load();
    http.expectOne('/api/me').flush(me());
    await done;

    expect(store.me()?.nickname).toBe('Gandalf');
    expect(store.isPending()).toBe(false);
    expect(socket.connect).toHaveBeenCalledOnce();
  });

  it('logout() → POST /api/auth/logout, очищає стан і відключає сокет', async () => {
    const loaded = store.load();
    http.expectOne('/api/me').flush(me());
    await loaded;

    const done = store.logout();
    const req = http.expectOne('/api/auth/logout');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;

    expect(store.me()).toBeNull();
    expect(store.isAuthenticated()).toBe(false);
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('load() з 5xx до першого успіху → стан «невідомо», не гість', async () => {
    const done = store.load();
    http
      .expectOne('/api/me')
      .flush({ error: { code: 'INTERNAL' } }, { status: 500, statusText: 'Server Error' });
    await done;

    expect(store.me()).toBeNull();
    expect(store.loadFailed()).toBe(true);
    expect(store.isUnknown()).toBe(true);
  });

  it('load() з мережевою помилкою не розлогінює активного користувача', async () => {
    const first = store.load();
    http.expectOne('/api/me').flush(me());
    await first;

    const again = store.load();
    http.expectOne('/api/me').error(new ProgressEvent('error'));
    await again;

    expect(store.me()?.nickname).toBe('Gandalf');
    expect(store.isAuthenticated()).toBe(true);
    expect(store.loadFailed()).toBe(true);
    expect(store.isUnknown()).toBe(false);
  });

  it('успішне повторне load() скидає помилку', async () => {
    const failed = store.load();
    http.expectOne('/api/me').error(new ProgressEvent('error'));
    await failed;

    const ok = store.load();
    http
      .expectOne('/api/me')
      .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'Unauthorized' });
    await ok;

    expect(store.loadFailed()).toBe(false);
    expect(store.isUnknown()).toBe(false);
    expect(store.isAuthenticated()).toBe(false);
  });

  describe('втрата сесії в іншій вкладці/пристрої', () => {
    async function login(): Promise<void> {
      const loaded = store.load();
      http.expectOne('/api/me').flush(me());
      await loaded;
    }
    const unauthorized = { status: 401, statusText: 'Unauthorized' };

    it('sessionLost$ → перевіряє /api/me; 401 → очищає стан і веде на /login з returnTo', async () => {
      await login();
      lost$.next('revoked');
      http.expectOne('/api/me').flush({ error: { code: 'UNAUTHENTICATED' } }, unauthorized);
      await vi.waitFor(() => expect(store.me()).toBeNull());

      expect(socket.disconnect).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { error: 'UNAUTHENTICATED', returnTo: '/account' },
      });
    });

    it('sessionLost$ з живою сесією (200) → стан лишається, без навігації', async () => {
      await login();
      lost$.next('revoked');
      http.expectOne('/api/me').flush(me({ nickname: 'Saruman' }));
      await store.revalidate();

      expect(store.me()?.nickname).toBe('Saruman');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('403 ACCOUNT_BANNED → вихід і /login?error=ACCOUNT_BANNED', async () => {
      await login();
      lost$.next('revoked');
      http
        .expectOne('/api/me')
        .flush({ error: { code: 'ACCOUNT_BANNED' } }, { status: 403, statusText: 'Forbidden' });
      await vi.waitFor(() => expect(store.me()).toBeNull());
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { error: 'ACCOUNT_BANNED', returnTo: '/account' },
      });
    });

    it('403 ACCOUNT_BANNED з деталями → токен апеляції лише в пам’яті (pendingBan)', async () => {
      await login();
      lost$.next('revoked');
      http
        .expectOne('/api/me')
        .flush(
          { error: { code: 'ACCOUNT_BANNED', details: { appealToken: 'tok', appealSent: true } } },
          { status: 403, statusText: 'Forbidden' },
        );
      await vi.waitFor(() => expect(store.me()).toBeNull());
      expect(store.pendingBan()).toEqual({ appealToken: 'tok', appealSent: true });
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { error: 'ACCOUNT_BANNED', returnTo: '/account' },
      });
      store.clearPendingBan();
      expect(store.pendingBan()).toBeNull();
    });

    it('sessionLost$ під час власного виходу → без /api/me і без навігації з error', async () => {
      await login();
      const done = store.logout();
      lost$.next('revoked');
      http.expectNone('/api/me');
      http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
      await done;
      expect(navigate).not.toHaveBeenCalled();
    });

    it('два сигнали поспіль → один запит /api/me', async () => {
      await login();
      lost$.next('revoked');
      lost$.next('server-disconnect');
      http.expectOne('/api/me').flush(me());
      await store.revalidate().catch(() => undefined);
    });

    it('уже на /login → без навігації', async () => {
      await login();
      vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue('/login');
      lost$.next('revoked');
      http.expectOne('/api/me').flush({}, unauthorized);
      await vi.waitFor(() => expect(store.me()).toBeNull());
      expect(navigate).not.toHaveBeenCalled();
    });

    it('небезпечний returnTo (//evil) відкидається', async () => {
      await login();
      vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue('//evil.example');
      lost$.next('revoked');
      http.expectOne('/api/me').flush({}, unauthorized);
      await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { error: 'UNAUTHENTICATED' },
      });
    });

    it('5xx зберігає користувача; для revoked пробує перепідключити сокет', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await login();
        socket.connect.mockClear();
        lost$.next('revoked');
        http.expectOne('/api/me').flush({}, { status: 500, statusText: 'Server Error' });
        await vi.waitFor(() => expect(store.loadFailed()).toBe(true));
        expect(store.me()?.nickname).toBe('Gandalf');
        vi.advanceTimersByTime(1000);
        expect(socket.connect).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('auth-error + 200 не перепідключає сокет (двічі поспіль теж)', async () => {
      await login();
      socket.connect.mockClear();
      for (let i = 0; i < 2; i++) {
        lost$.next('auth-error');
        http.expectOne('/api/me').flush(me());
        await store.revalidate();
      }
      expect(socket.connect).not.toHaveBeenCalled();
      expect(store.me()?.nickname).toBe('Gandalf');
    });

    it('auth-error + 200 після 5xx скидає банер loadFailed', async () => {
      await login();
      lost$.next('auth-error');
      http.expectOne('/api/me').flush({}, { status: 500, statusText: 'Server Error' });
      await vi.waitFor(() => expect(store.loadFailed()).toBe(true));
      lost$.next('auth-error');
      http.expectOne('/api/me').flush(me());
      await vi.waitFor(() => expect(store.loadFailed()).toBe(false));
    });

    it('запізніла 200 після виходу не воскрешає користувача', async () => {
      await login();
      lost$.next('revoked');
      const req = http.expectOne('/api/me');
      const done = store.logout();
      http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
      await done;
      req.flush(me());
      await store.revalidate();
      expect(store.me()).toBeNull();
    });

    it('5xx після connect_error не перепідключає сокет', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await login();
        socket.connect.mockClear();
        lost$.next('auth-error');
        http.expectOne('/api/me').flush({}, { status: 500, statusText: 'Server Error' });
        await vi.waitFor(() => expect(store.loadFailed()).toBe(true));
        vi.advanceTimersByTime(10000);
        expect(socket.connect).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('мережева помилка під час перевірки не розлогінює', async () => {
      await login();
      lost$.next('revoked');
      http.expectOne('/api/me').error(new ProgressEvent('error'));
      await vi.waitFor(() => expect(store.loadFailed()).toBe(true));

      expect(store.me()?.nickname).toBe('Gandalf');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('для гостя sessionLost$ нічого не робить', () => {
      lost$.next('revoked');
      http.expectNone('/api/me');
    });

    it('повідомлення BroadcastChannel від іншої вкладки → перевірка /api/me і вихід', async () => {
      await login();
      const peer = new BroadcastChannel('nri-auth');
      peer.postMessage('logout');
      peer.close();
      const req = await vi.waitFor(() => http.expectOne('/api/me'));
      req.flush({ error: { code: 'UNAUTHENTICATED' } }, unauthorized);
      await vi.waitFor(() => expect(store.me()).toBeNull());
      expect(navigate).toHaveBeenCalled();
    });

    it('logout() сповіщає інші вкладки через BroadcastChannel', async () => {
      await login();
      const peer = new BroadcastChannel('nri-auth');
      const got = new Promise((r) => (peer.onmessage = (e) => r(e.data)));
      const done = store.logout();
      http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
      await done;
      expect(await got).toBe('logout');
      peer.close();
    });
  });

  describe('локальні чернетки форми гри', () => {
    const seed = () => {
      localStorage.setItem('nri.gameDraft.1.new', '{}');
      localStorage.setItem('nri.gameDraft.1.5', '{}');
      localStorage.setItem('other.key', 'keep');
    };
    const drafts = () => Object.keys(localStorage).filter((k) => k.startsWith('nri.gameDraft.'));

    it('logout() видаляє всі nri.gameDraft.*, інші ключі лишає', async () => {
      store.setMe(me());
      seed();
      const done = store.logout();
      http.expectOne('/api/auth/logout').flush(null);
      await done;
      expect(drafts()).toEqual([]);
      expect(localStorage.getItem('other.key')).toBe('keep');
    });

    it('втрата сесії (401 під час перевірки) теж видаляє чернетки', async () => {
      store.setMe(me());
      seed();
      lost$.next('revoked');
      http
        .expectOne('/api/me')
        .flush({ error: { code: 'UNAUTHENTICATED' } }, { status: 401, statusText: 'Unauthorized' });
      await Promise.resolve();
      await Promise.resolve();
      expect(drafts()).toEqual([]);
    });

    it('збій сховища не ламає вихід', async () => {
      store.setMe(me());
      vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
        throw new Error('denied');
      });
      const done = store.logout();
      http.expectOne('/api/auth/logout').flush(null);
      await done;
      expect(store.me()).toBeNull();
      vi.restoreAllMocks();
    });
  });
});
