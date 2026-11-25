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
  /** Перечитати не вдалося — повернути області (банер знову видно). */
  restore(scopes: Iterable<GameChangeScope>): void;
  /**
   * Сторінка щойно сама змінила дані: ігнорувати пінги цих областей (без них — усіх) ще `ms`.
   * Пінги інших областей і далі піднімають банер.
   */
  quiet(scopes?: readonly GameChangeScope[], ms?: number): void;
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
    const quietUntil = new Map<GameChangeScope, number>();
    let stopped = false;
    const subs: Subscription[] = [];
    const add = (list: Iterable<GameChangeScope>) =>
      pending.update((set) => {
        const next = new Set(set);
        for (const s of list) if (scopes.has(s)) next.add(s);
        return next.size === set.size ? set : next;
      });

    const sendWatch = () => {
      if (stopped || !watch) return;
      void this.socket.request<GameWatchAck>(GAME_WATCH, { gameId }).then(() => {
        // Підтвердження прийшло вже після відписки — сервер встиг додати нас у кімнати.
        if (stopped) this.socket.send(GAME_UNWATCH, { gameId });
      });
    };

    subs.push(
      this.socket.on<GameChangedPing>(GAME_CHANGED).subscribe((ping) => {
        if (!ping || !scopes.has(ping.scope)) return;
        if (gameId !== undefined && ping.gameId !== gameId) return;
        if (Date.now() < (quietUntil.get(ping.scope) ?? 0)) return;
        add([ping.scope]);
      }),
    );
    // Перепідключення (не перше підключення): пінги за час розриву втрачено — вважаємо, що
    // змінилось усе, що цікавить сторінку.
    let hadConnection = this.socket.isConnected();
    subs.push(
      this.socket.connected$.subscribe(() => {
        if (hadConnection) add(scopes);
        hadConnection = true;
        sendWatch();
      }),
    );
    sendWatch();

    return {
      pending: pending.asReadonly(),
      take: () => {
        const taken = new Set(pending());
        pending.set(new Set());
        return taken;
      },
      restore: (list) => add(list),
      quiet: (list = [...scopes], ms = QUIET_MS) => {
        const until = Date.now() + ms;
        for (const s of list) quietUntil.set(s, until);
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
