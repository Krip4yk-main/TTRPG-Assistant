import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ChangeWatcher } from './change-watcher';
import { SocketService } from './socket.service';

describe('ChangeWatcher', () => {
  let pings: Subject<unknown>;
  let connected: Subject<void>;
  let request: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let watcher: ChangeWatcher;
  let isConnected: boolean;

  beforeEach(() => {
    pings = new Subject();
    connected = new Subject();
    request = vi.fn(() => Promise.resolve({ ok: true, members: false }));
    send = vi.fn();
    isConnected = false;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SocketService,
          useValue: {
            on: (ev: string) => (ev === 'game.changed' ? pings : new Subject()),
            connected$: connected,
            isConnected: () => isConnected,
            request,
            send,
          },
        },
      ],
    });
    watcher = TestBed.inject(ChangeWatcher);
  });

  it('watches on open and re-watches after every reconnect', () => {
    watcher.open({ gameId: 7, watch: true, scopes: ['details'] });
    expect(request).toHaveBeenCalledExactlyOnceWith('game.watch', { gameId: 7 });
    connected.next();
    connected.next();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rewatch() repeats game.watch (viewer relation changed)', () => {
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['details'] });
    h.rewatch();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('collects only pings of its game and scopes; take() clears them', () => {
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['details', 'sessions'] });
    pings.next({ gameId: 8, scope: 'details' });
    pings.next({ gameId: 7, scope: 'applications' });
    expect(h.pending().size).toBe(0);
    pings.next({ gameId: 7, scope: 'sessions' });
    pings.next({ gameId: 7, scope: 'sessions' });
    pings.next({ gameId: 7, scope: 'details' });
    expect([...h.pending()].sort()).toEqual(['details', 'sessions']);
    expect([...h.take()].sort()).toEqual(['details', 'sessions']);
    expect(h.pending().size).toBe(0);
  });

  it('without gameId accepts pings of any game and does not watch rooms', () => {
    const h = watcher.open({ scopes: ['applications'] });
    expect(request).not.toHaveBeenCalled();
    pings.next({ gameId: 3, scope: 'applications' });
    expect(h.pending().has('applications')).toBe(true);
  });

  it('quiet() ignores pings caused by the page itself for a while', () => {
    vi.useFakeTimers();
    try {
      const h = watcher.open({ gameId: 7, watch: true, scopes: ['sessions'] });
      h.quiet(undefined, 1000);
      pings.next({ gameId: 7, scope: 'sessions' });
      expect(h.pending().size).toBe(0);
      vi.advanceTimersByTime(1001);
      pings.next({ gameId: 7, scope: 'sessions' });
      expect(h.pending().size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() unwatches, ignores later pings and reconnects', () => {
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['details'] });
    h.stop();
    h.stop();
    expect(send).toHaveBeenCalledExactlyOnceWith('game.unwatch', { gameId: 7 });
    pings.next({ gameId: 7, scope: 'details' });
    connected.next();
    expect(h.pending().size).toBe(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('quiet(scopes) silences only those scopes', () => {
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['sessions', 'members'] });
    h.quiet(['sessions']);
    pings.next({ gameId: 7, scope: 'sessions' });
    pings.next({ gameId: 7, scope: 'members' });
    expect([...h.pending()]).toEqual(['members']);
  });

  it('a reconnect (not the first connect) marks every scope pending', () => {
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['details', 'sessions'] });
    connected.next();
    expect(h.pending().size).toBe(0);
    connected.next();
    expect([...h.pending()].sort()).toEqual(['details', 'sessions']);
  });

  it('opened while connected: the next connect is a reconnect', () => {
    isConnected = true;
    const h = watcher.open({ scopes: ['applications'] });
    connected.next();
    expect([...h.pending()]).toEqual(['applications']);
  });

  it('restore() puts taken scopes back (failed reload)', () => {
    const h = watcher.open({ gameId: 7, scopes: ['details', 'sessions'] });
    pings.next({ gameId: 7, scope: 'details' });
    const taken = h.take();
    expect(h.pending().size).toBe(0);
    h.restore(taken);
    expect([...h.pending()]).toEqual(['details']);
  });

  it('a watch ack arriving after stop() sends unwatch again', async () => {
    let ack!: (v: unknown) => void;
    request.mockReturnValueOnce(new Promise((r) => (ack = r)));
    const h = watcher.open({ gameId: 7, watch: true, scopes: ['details'] });
    h.stop();
    expect(send).toHaveBeenCalledTimes(1);
    ack({ ok: true, members: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('game.unwatch', { gameId: 7 });
  });
});
