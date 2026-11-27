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
  uiTheme: 'quest-board',
  availableThemes: ['quest-board'],
  uiPrefs: { tearAnimation: true, sendAnimation: true },
  myLimits: [],
  avatarSource: 'auto',
  customAvatarUrl: null,
  avatarOptions: [],
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
  let connected: Subject<void>;

  beforeEach(() => {
    events = new Map();
    connected = new Subject();
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
            connected$: connected,
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

  it('markAllRead marks every item and re-reads the count from the server', async () => {
    await login(2);
    await loadFirst([notification(1), notification(2)]);
    const p = store.markAllRead();
    const req = http.expectOne('/api/me/notifications/read-all');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await flushAsync();
    // Поки летів read-all, прийшло ще одне.
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 1 });
    await p;
    expect(store.unreadCount()).toBe(1);
    expect(store.items().every((n) => n.readAt !== null)).toBe(true);
  });

  it('markAllRead failure keeps the count and items unread', async () => {
    await login(2);
    await loadFirst([notification(1), notification(2)]);
    const p = store.markAllRead();
    http
      .expectOne('/api/me/notifications/read-all')
      .flush(null, { status: 500, statusText: 'err' });
    await p;
    expect(store.unreadCount()).toBe(2);
    expect(store.items().every((n) => n.readAt === null)).toBe(true);
  });

  it('remove drops the item and decrements the count only for an unread one', async () => {
    await login(2);
    await loadFirst([notification(1), notification(2, { readAt: '2026-11-25T11:00:00.000Z' })]);
    const p1 = store.remove(notification(1));
    expect(store.unreadCount()).toBe(1);
    expect(store.items().map((n) => n.id)).toEqual([2]);
    const req = http.expectOne('/api/me/notifications/1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await p1;
    const p2 = store.remove(notification(2, { readAt: '2026-11-25T11:00:00.000Z' }));
    http
      .expectOne('/api/me/notifications/2')
      .flush(null, { status: 204, statusText: 'No Content' });
    await p2;
    expect(store.unreadCount()).toBe(1);
    expect(store.items()).toEqual([]);
  });

  it('remove failure reloads the list and the count', async () => {
    await login(1);
    await loadFirst([notification(1)]);
    const p = store.remove(notification(1));
    http.expectOne('/api/me/notifications/1').flush(null, { status: 500, statusText: 'err' });
    await p;
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 1 });
    http
      .expectOne((r) => r.url === '/api/me/notifications')
      .flush({
        items: [notification(1)],
        nextCursor: null,
      });
    await flushAsync();
    expect(store.items().map((n) => n.id)).toEqual([1]);
    expect(store.unreadCount()).toBe(1);
  });

  it('removeRead drops read items and re-reads the count', async () => {
    await login(1);
    await loadFirst([notification(1), notification(2, { readAt: '2026-11-25T11:00:00.000Z' })]);
    const p = store.removeRead();
    const req = http.expectOne('/api/me/notifications/read');
    expect(req.request.method).toBe('DELETE');
    req.flush({ deleted: 1 });
    await flushAsync();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 1 });
    await p;
    expect(store.items().map((n) => n.id)).toEqual([1]);
    expect(store.unreadCount()).toBe(1);
  });

  it('removeRead failure changes nothing', async () => {
    await login(0);
    await loadFirst([notification(2, { readAt: '2026-11-25T11:00:00.000Z' })]);
    const p = store.removeRead();
    http.expectOne('/api/me/notifications/read').flush(null, { status: 500, statusText: 'err' });
    await p;
    expect(store.items().length).toBe(1);
  });

  it('a stale unread-count response does not overwrite a newer one', async () => {
    await login(1);
    const first = store.refreshUnread();
    const second = store.refreshUnread();
    const [older, newer] = http.match('/api/me/notifications/unread-count');
    newer!.flush({ count: 5 });
    older!.flush({ count: 2 });
    await Promise.all([first, second]);
    expect(store.unreadCount()).toBe(5);
  });

  it('socket reconnect and returning to the tab refresh the count', async () => {
    await login(1);
    connected.next();
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 4 });
    await flushAsync();
    expect(store.unreadCount()).toBe(4);

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectNone('/api/me/notifications/unread-count');
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 6 });
    await flushAsync();
    expect(store.unreadCount()).toBe(6);
    state.mockRestore();
  });

  it('new notification with the panel open merges the first page on top, keeping loaded pages', async () => {
    await login(1);
    store.setPanelOpen(true);
    await loadFirst([notification(3), notification(2)], 2);
    const more = store.loadMore();
    http
      .expectOne((r) => r.url === '/api/me/notifications')
      .flush({ items: [notification(1)], nextCursor: null });
    await more;

    events.get(NOTIFICATION_NEW_EVENT)!.next({ id: 4 });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 2 });
    http
      .expectOne((r) => r.url === '/api/me/notifications')
      .flush({ items: [notification(4), notification(3)], nextCursor: 3 });
    await flushAsync();
    expect(store.items().map((n) => n.id)).toEqual([4, 3, 2, 1]);
    expect(store.nextCursor()).toBeNull();
  });

  it('switching user A → B resets the list and loads the count of B', async () => {
    await login(3);
    await loadFirst([notification(1)]);
    auth.setMe({ ...testMe, id: 2, publicId: 'bbbbbbbbbb' });
    TestBed.tick();
    expect(store.items()).toEqual([]);
    expect(store.loaded()).toBe(false);
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 7 });
    await flushAsync();
    expect(store.unreadCount()).toBe(7);
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
