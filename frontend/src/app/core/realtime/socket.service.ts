import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { io, type Socket } from 'socket.io-client';

/**
 * Обгортка над Socket.IO. Сокет створюється ліниво й підключається лише для активного
 * користувача (кука сесії — автентифікація). Підписки через `on()` переживають
 * перепідключення, бо слухачі висять на одному екземплярі `Socket`.
 */
@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket: Socket | null = null;

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
    this.socket ??= io({ path: '/socket.io', withCredentials: true, autoConnect: false });
    return this.socket;
  }
}
