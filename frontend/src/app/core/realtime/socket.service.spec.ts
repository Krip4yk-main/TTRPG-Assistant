import { TestBed } from '@angular/core/testing';
import type { Mock } from 'vitest';
import type { io } from 'socket.io-client';
import { SOCKET_IO, SocketService } from './socket.service';

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
const fakeIo = () => ({
  connected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: (ev: string, h: Handler) => handlers.set(ev, h),
  off: vi.fn(),
});

describe('SocketService sessionLost$', () => {
  let service: SocketService;
  let lost: Mock;

  beforeEach(() => {
    handlers.clear();
    TestBed.configureTestingModule({
      providers: [{ provide: SOCKET_IO, useValue: fakeIo as unknown as typeof io }],
    });
    service = TestBed.inject(SocketService);
    lost = vi.fn();
    service.sessionLost$.subscribe(() => lost());
    service.connect();
  });

  it("'session.revoked' → емітить", () => {
    handlers.get('session.revoked')?.();
    expect(lost).toHaveBeenCalledOnce();
  });

  it("disconnect 'io server disconnect' → емітить", () => {
    handlers.get('disconnect')?.('io server disconnect');
    expect(lost).toHaveBeenCalledOnce();
  });

  it.each(['transport close', 'ping timeout', 'transport error'])(
    "disconnect '%s' ігнорується (socket.io перепідключиться сам)",
    (reason) => {
      handlers.get('disconnect')?.(reason);
      expect(lost).not.toHaveBeenCalled();
    },
  );

  it.each(['UNAUTHENTICATED', 'PROFILE_INCOMPLETE'])('connect_error %s → емітить', (message) => {
    handlers.get('connect_error')?.(new Error(message));
    expect(lost).toHaveBeenCalledOnce();
  });

  it('connect_error з мережевою помилкою ігнорується', () => {
    handlers.get('connect_error')?.(new Error('xhr poll error'));
    expect(lost).not.toHaveBeenCalled();
  });
});
