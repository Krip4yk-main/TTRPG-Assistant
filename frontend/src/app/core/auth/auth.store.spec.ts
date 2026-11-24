import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { AuthStore } from './auth.store';
import { SocketService } from '../realtime/socket.service';
import type { MeDto } from './me.model';

const me = (over: Partial<MeDto> = {}): MeDto => ({
  id: 1,
  nickname: 'Gandalf',
  avatarUrl: null,
  birthDate: '1990-01-01',
  role: 'user',
  status: 'active',
  timezone: 'Europe/Kyiv',
  locale: 'uk',
  identities: [{ provider: 'dev', displayName: 'Gandalf' }],
  ...over,
});

describe('AuthStore', () => {
  let store: AuthStore;
  let http: HttpTestingController;
  const lost$ = new Subject<void>();
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
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true) as unknown as ReturnType<
      typeof vi.fn
    >;
  });

  afterEach(() => http.verify());

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
      lost$.next();
      http.expectOne('/api/me').flush({ error: { code: 'UNAUTHENTICATED' } }, unauthorized);
      await vi.waitFor(() => expect(store.me()).toBeNull());

      expect(socket.disconnect).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { error: 'UNAUTHENTICATED', returnTo: '/account' },
      });
    });

    it('sessionLost$ з живою сесією (200) → стан лишається, без навігації', async () => {
      await login();
      lost$.next();
      http.expectOne('/api/me').flush(me());
      await vi.waitFor(() => expect(http.match('/api/me')).toEqual([]));

      expect(store.me()?.nickname).toBe('Gandalf');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('мережева помилка під час перевірки не розлогінює', async () => {
      await login();
      lost$.next();
      http.expectOne('/api/me').error(new ProgressEvent('error'));
      await vi.waitFor(() => expect(store.loadFailed()).toBe(true));

      expect(store.me()?.nickname).toBe('Gandalf');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('для гостя sessionLost$ нічого не робить', () => {
      lost$.next();
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
});
