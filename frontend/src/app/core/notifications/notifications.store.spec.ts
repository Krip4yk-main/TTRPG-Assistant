import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type MeDto, type NotificationDto } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { SocketService } from '../realtime/socket.service';
import { NotificationsStore } from './notifications.store';

const testMe: MeDto = {
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
};

function notification(id: number, extra: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id,
    type: 'game.started',
    category: 'games',
    params: { gameId: 7, gameTitle: 'Копальні Морії' },
    link: '/games/7',
    createdAt: '2026-11-25T10:00:00.000Z',
    readAt: null,
    ...extra,
  };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('NotificationsStore', () => {
  let http: HttpTestingController;
  let store: NotificationsStore;
  let auth: AuthStore;
  let events: Map<string, Subject<unknown>>;

  beforeEach(() => {
    events = new Map();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            sessionLost$: new Subject(),
            on: (event: string) => {
              if (!events.has(event)) events.set(event, new Subject());
              return events.get(event)!.asObservable();
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthStore);
    store = TestBed.inject(NotificationsStore);
  });

  afterEach(() => http.verify());

  const login = async (count = 3) => {
    auth.setMe(testMe);
    TestBed.tick();
    http.expectOne('/api/me/notifications/unread-count').flush({ count });
    await flushAsync();
  };

  const loadFirst = async (items: NotificationDto[], nextCursor: number | null = null) => {
    const p = store.loadFirst();
    const req = http.expectOne((r) => r.url === '/api/me/notifications');
    expect(req.request.params.has('cursor')).toBe(false);
    req.flush({ items, nextCursor });
    await p;
  };

  it('guest: no request; active user: loads the unread count', async () => {
    TestBed.tick();
    http.expectNone('/api/me/notifications/unread-count');
    await login(5);
    expect(store.unreadCount()).toBe(5);
  });

  it('loadFirst then loadMore appends the next page with the cursor (no duplicates)', async () => {
    await login();
    await loadFirst([notification(3), notification(2)], 2);
    expect(store.items().map((n) => n.id)).toEqual([3, 2]);
    expect(store.hasMore()).toBe(true);

    const p = store.loadMore();
    const req = http.expectOne((r) => r.url === '/api/me/notifications');
    expect(req.request.params.get('cursor')).toBe('2');
    req.flush({ items: [notification(2), notification(1)], nextCursor: null });
    await p;
    expect(store.items().map((n) => n.id)).toEqual([3, 2, 1]);
    expect(store.hasMore()).toBe(false);

    await store.loadMore(); // кінець — без запиту
    http.expectNone('/api/me/notifications');
  });

  it('markRead: optimistic, decrements the count, keeps server DTO', async () => {
    await login(2);
    await loadFirst([notification(1), notification(2)]);
    const p = store.markRead(store.items()[0]!);
    expect(store.items()[0]!.readAt).not.toBeNull();
    expect(store.unreadCount()).toBe(1);
    const req = http.expectOne('/api/me/notifications/1/read');
    expect(req.request.method).toBe('POST');
    req.flush(notification(1, { readAt: '2026-11-25T11:00:00.000Z' }));
    await p;
    expect(store.items()[0]!.readAt).toBe('2026-11-25T11:00:00.000Z');

    // Уже прочитане — без запиту.
    await store.markRead(store.items()[0]!);
    http.expectNone('/api/me/notifications/1/read');
  });

  it('markRead failure reverts and re-reads the count', async () => {
    await login(1);
    await loadFirst([notification(1)]);
    const p = store.markRead(store.items()[0]!);
    http.expectOne('/api/me/notifications/1/read').flush(null, { status: 500, statusText: 'err' });
    await flushAsync();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 1 });
    await p;
    await flushAsync();
    expect(store.items()[0]!.readAt).toBeNull();
    expect(store.unreadCount()).toBe(1);
  });

  it('markAllRead marks every item and zeroes the count', async () => {
    await login(2);
    await loadFirst([notification(1), notification(2)]);
    const p = store.markAllRead();
    const req = http.expectOne('/api/me/notifications/read-all');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await p;
    expect(store.unreadCount()).toBe(0);
    expect(store.items().every((n) => n.readAt !== null)).toBe(true);
  });

  it('socket notification.new refreshes the count; reloads the list only when the panel is open', async () => {
    await login(1);
    const socket = events.get(NOTIFICATION_NEW_EVENT)!;

    socket.next({ id: 9 });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 2 });
    http.expectNone('/api/me/notifications');
    await flushAsync();
    expect(store.unreadCount()).toBe(2);

    store.setPanelOpen(true);
    socket.next({ id: 10 });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 3 });
    http
      .expectOne((r) => r.url === '/api/me/notifications')
      .flush({ items: [notification(10), notification(9)], nextCursor: null });
    await flushAsync();
    expect(store.unreadCount()).toBe(3);
    expect(store.items()[0]!.id).toBe(10);
  });

  it('logout resets everything and ignores late responses', async () => {
    await login(4);
    await loadFirst([notification(1)]);
    store.setPanelOpen(true);
    const late = store.loadMore(); // без курсора — нічого
    await late;
    const pending = store.refreshUnread();
    auth.setMe(null);
    TestBed.tick();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 99 });
    await pending;
    expect(store.unreadCount()).toBe(0);
    expect(store.items()).toEqual([]);
    expect(store.loaded()).toBe(false);
    expect(store.panelOpen()).toBe(false);

    // Подія сокета після виходу ігнорується.
    events.get(NOTIFICATION_NEW_EVENT)!.next({ id: 2 });
    http.expectNone('/api/me/notifications/unread-count');
  });
});
