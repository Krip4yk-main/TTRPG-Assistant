import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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
  const socket = { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SocketService, useValue: socket },
      ],
    });
    store = TestBed.inject(AuthStore);
    http = TestBed.inject(HttpTestingController);
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
});
