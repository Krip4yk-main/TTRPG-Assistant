import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type NotificationDto } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { SocketService } from '../realtime/socket.service';
import { NotificationsApi } from './notifications.api';

/**
 * Центр сповіщень: лічильник непрочитаних (для дзвіночка) і список (для панелі).
 * Лічильник тягнеться, щойно користувач активний; список — коли відкривають панель.
 * Подія сокета `notification.new` оновлює лічильник, а при відкритій панелі — і першу
 * сторінку. Вихід або зміна користувача скидає все (відповіді старих запитів ігноруються).
 */
@Injectable({ providedIn: 'root' })
export class NotificationsStore {
  private readonly api = inject(NotificationsApi);
  private readonly auth = inject(AuthStore);

  private readonly _unread = signal(0);
  private readonly _unreadKnown = signal(false);
  private readonly _items = signal<NotificationDto[]>([]);
  private readonly _loading = signal(false);
  private readonly _loaded = signal(false);
  private readonly _error = signal(false);
  private readonly _nextCursor = signal<number | null>(null);
  private readonly _panelOpen = signal(false);
  /** Покоління стану: зростає при скиданні, щоб запізнілі відповіді не повертали старе. */
  private generation = 0;

  readonly unreadCount = this._unread.asReadonly();
  /** Лічильник уже отримано з сервера (після входу). */
  readonly unreadKnown = this._unreadKnown.asReadonly();
  readonly items = this._items.asReadonly();
  readonly loading = this._loading.asReadonly();
  /** Перша сторінка вже завантажувалася (щоб відрізнити «порожньо» від «ще не знаємо»). */
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  readonly nextCursor = this._nextCursor.asReadonly();
  readonly hasMore = computed(() => this._nextCursor() !== null);
  readonly panelOpen = this._panelOpen.asReadonly();

  private readonly userId = computed(() => (this.auth.isActive() ? this.auth.me()!.id : null));

  constructor() {
    effect(() => {
      const id = this.userId();
      untracked(() => {
        this.reset();
        if (id !== null) void this.refreshUnread();
      });
    });

    inject(SocketService)
      .on<{ id: number }>(NOTIFICATION_NEW_EVENT)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.userId() === null) return;
        void this.refreshUnread();
        if (this._panelOpen()) void this.loadFirst();
      });
  }

  setPanelOpen(open: boolean): void {
    this._panelOpen.set(open);
  }

  async refreshUnread(): Promise<void> {
    const gen = this.generation;
    try {
      const { count } = await firstValueFrom(this.api.unreadCount());
      if (gen === this.generation) {
        this._unread.set(count);
        this._unreadKnown.set(true);
      }
    } catch {
      // Лічильник не критичний: лишаємо попереднє значення.
    }
  }

  /** Перша сторінка (новіші першими) — замінює список. */
  async loadFirst(): Promise<void> {
    const gen = this.generation;
    this._loading.set(true);
    this._error.set(false);
    try {
      const page = await firstValueFrom(this.api.list());
      if (gen !== this.generation) return;
      this._items.set(page.items);
      this._nextCursor.set(page.nextCursor);
      this._loaded.set(true);
    } catch {
      if (gen === this.generation) this._error.set(true);
    } finally {
      if (gen === this.generation) this._loading.set(false);
    }
  }

  /** Наступна сторінка — дописується в кінець (без дублікатів). */
  async loadMore(): Promise<void> {
    const cursor = this._nextCursor();
    if (cursor === null || this._loading()) return;
    const gen = this.generation;
    this._loading.set(true);
    this._error.set(false);
    try {
      const page = await firstValueFrom(this.api.list(cursor));
      if (gen !== this.generation) return;
      const known = new Set(this._items().map((n) => n.id));
      this._items.update((items) => [...items, ...page.items.filter((n) => !known.has(n.id))]);
      this._nextCursor.set(page.nextCursor);
    } catch {
      if (gen === this.generation) this._error.set(true);
    } finally {
      if (gen === this.generation) this._loading.set(false);
    }
  }

  /** Позначити прочитаним: оптимістично; при помилці — перечитати лічильник. */
  async markRead(n: NotificationDto): Promise<void> {
    if (n.readAt) return;
    const gen = this.generation;
    this.patch(n.id, { readAt: new Date().toISOString() });
    this._unread.update((c) => Math.max(0, c - 1));
    try {
      const saved = await firstValueFrom(this.api.markRead(n.id));
      if (gen === this.generation) this.patch(n.id, saved);
    } catch {
      if (gen === this.generation) {
        this.patch(n.id, { readAt: null });
        void this.refreshUnread();
      }
    }
  }

  async markAllRead(): Promise<void> {
    const gen = this.generation;
    try {
      await firstValueFrom(this.api.markAllRead());
    } catch {
      return;
    }
    if (gen !== this.generation) return;
    const now = new Date().toISOString();
    this._items.update((items) => items.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    this._unread.set(0);
  }

  private patch(id: number, changes: Partial<NotificationDto>): void {
    this._items.update((items) => items.map((n) => (n.id === id ? { ...n, ...changes } : n)));
  }

  private reset(): void {
    this.generation++;
    this._unread.set(0);
    this._unreadKnown.set(false);
    this._items.set([]);
    this._nextCursor.set(null);
    this._loading.set(false);
    this._loaded.set(false);
    this._error.set(false);
    this._panelOpen.set(false);
  }
}
