import { Injectable, inject, signal, type Signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { GameChangeScope, GameChangedPing, GameWatchAck } from '@nri/shared';
import { SocketService } from './socket.service';

/** Дзеркала подій з `@nri/shared/realtime` (фронтенд не тягне runtime-код shared заради рядків). */
export const GAME_CHANGED = 'game.changed';
export const GAME_WATCH = 'game.watch';
export const GAME_UNWATCH = 'game.unwatch';

/** Після власної дії сторінки її ж пінги не мають показувати банер, мс. */
const QUIET_MS = 3_000;

export interface ChangeHandle {
  /** Області, що змінились і ще не перечитані сторінкою. */
  readonly pending: Signal<ReadonlySet<GameChangeScope>>;
  /** Забрати накопичені області (банер зникає) — сторінка перечитує саме їх. */
  take(): Set<GameChangeScope>;
  /** Сторінка щойно сама змінила дані: ігнорувати пінги ще `ms`. */
  quiet(ms?: number): void;
  /** Повторити `game.watch` (стосунок глядача змінився — сервер переоцінить кімнати). */
  rewatch(): void;
  stop(): void;
}

export interface ChangeOptions {
  /** Гра сторінки: пінги інших ігор відкидаються. Без неї — будь-яка гра. */
  gameId?: number;
  /** Які області цікавлять сторінку. */
  scopes: readonly GameChangeScope[];
  /** Підписатися на кімнати гри (`game.watch`); інакше — лише особисті пінги. */
  watch?: boolean;
}

/**
 * Підписки сторінок на пінги `game.changed`. Пінг лише сигналізує «є зміни» — сторінка
 * показує банер і перечитує дані, коли користувач погодиться (не замінюємо вміст під руками).
 * `game.watch` повторюється після кожного (пере)підключення: кімнати сокета не переживають
 * розрив з'єднання.
 */
@Injectable({ providedIn: 'root' })
export class ChangeWatcher {
  private readonly socket = inject(SocketService);

  open(options: ChangeOptions): ChangeHandle {
    const pending = signal<ReadonlySet<GameChangeScope>>(new Set());
    const scopes = new Set(options.scopes);
    const { gameId } = options;
    const watch = !!options.watch && gameId !== undefined;
    let quietUntil = 0;
    let stopped = false;
    const subs: Subscription[] = [];

    const sendWatch = () => {
      if (stopped || !watch) return;
      void this.socket.request<GameWatchAck>(GAME_WATCH, { gameId });
    };

    subs.push(
      this.socket.on<GameChangedPing>(GAME_CHANGED).subscribe((ping) => {
        if (!ping || !scopes.has(ping.scope)) return;
        if (gameId !== undefined && ping.gameId !== gameId) return;
        if (Date.now() < quietUntil) return;
        pending.update((set) => (set.has(ping.scope) ? set : new Set([...set, ping.scope])));
      }),
    );
    if (watch) {
      subs.push(this.socket.connected$.subscribe(() => sendWatch()));
      sendWatch();
    }

    return {
      pending: pending.asReadonly(),
      take: () => {
        const taken = new Set(pending());
        pending.set(new Set());
        return taken;
      },
      quiet: (ms = QUIET_MS) => {
        quietUntil = Date.now() + ms;
      },
      rewatch: sendWatch,
      stop: () => {
        if (stopped) return;
        stopped = true;
        subs.forEach((s) => s.unsubscribe());
        if (watch) this.socket.send(GAME_UNWATCH, { gameId });
      },
    };
  }
}
