import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

/**
 * Обгортка над Socket.IO. Сокет створюється ліниво й підключається лише для активного
 * користувача (кука сесії — автентифікація). Підписки через `on()` переживають
 * перепідключення, бо слухачі висять на одному екземплярі `Socket`.
 */
export type SessionLostReason = 'revoked' | 'server-disconnect' | 'auth-error';

/**
 * Фабрика клієнта Socket.IO. Токен — щоб тести підміняли клієнт через DI: `vi.mock` модуля
 * ненадійний, коли Vitest виконує файли специфікацій без ізоляції (спільний кеш модулів).
 */
export const SOCKET_IO = new InjectionToken<typeof io>('SOCKET_IO', {
  providedIn: 'root',
  factory: () => io,
});

@Injectable({ providedIn: 'root' })
export class SocketService {
  private readonly io = inject(SOCKET_IO);
  private socket: Socket | null = null;
  private readonly lost = new Subject<SessionLostReason>();
  private readonly connected = new Subject<void>();

  /**
   * Сервер дав зрозуміти, що сесію втрачено (відкликано, бан, видалення акаунта).
   * Тимчасові мережеві розриви сюди не потрапляють: socket.io перепідключиться сам.
   */
  readonly sessionLost$: Observable<SessionLostReason> = this.lost.asObservable();

  /**
   * Кожне (пере)підключення сокета. Події, що прийшли, поки з'єднання не було, втрачено —
   * підписники перечитують стан через API.
   */
  readonly connected$: Observable<void> = this.connected.asObservable();

  connect(): void {
    const socket = this.ensure();
    if (!socket.connected) socket.connect();
  }

  disconnect(): void {
    this.socket?.disconnect();
  }

  on<T>(event: string): Observable<T> {
    return new Observable<T>((subscriber) => {
      const socket = this.ensure();
      const handler = (payload: T) => subscriber.next(payload);
      socket.on(event, handler);
      return () => socket.off(event, handler);
    });
  }

  private ensure(): Socket {
    if (!this.socket) {
      const socket = this.io({ path: '/socket.io', withCredentials: true, autoConnect: false });
      // Дзеркало SESSION_REVOKED_EVENT з @nri/shared (фронтенд не тягне shared заради рядка).
      socket.on('session.revoked', () => this.lost.next('revoked'));
      socket.on('connect', () => this.connected.next());
      // Сервер сам розірвав з'єднання (disconnectSockets) — це не мережа.
      socket.on('disconnect', (reason: string) => {
        if (reason === 'io server disconnect') this.lost.next('server-disconnect');
      });
      socket.on('connect_error', (err: Error) => {
        if (err.message === 'UNAUTHENTICATED' || err.message === 'PROFILE_INCOMPLETE') {
          this.lost.next('auth-error');
        }
      });
      this.socket = socket;
    }
    return this.socket;
  }
}
