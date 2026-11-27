import { DOCUMENT, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, fromEvent, merge } from 'rxjs';
import { NOTIFICATION_NEW_EVENT, type NotificationDto } from '@nri/shared';
import { AuthStore } from '../auth/auth.store';
import { SocketService } from '../realtime/socket.service';
import { NotificationsApi } from './notifications.api';

/**
 * Центр сповіщень: лічильник непрочитаних (для дзвіночка) і список (для панелі).
 * Лічильник тягнеться, щойно користувач активний; список — коли відкривають панель.
 * Подія сокета `notification.new` оновлює лічильник, а при відкритій панелі — підмішує нові
 * сповіщення першої сторінки згори (довантажені сторінки й курсор лишаються). Те саме — при
 * (пере)підключенні сокета й поверненні на вкладку: події, пропущені без з'єднання, не губляться.
 * Вихід або зміна користувача скидає все (відповіді старих запитів ігноруються).
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
  /** Номер останнього запиту/зміни лічильника: застаріла відповідь не перезаписує новішу. */
  private unreadSeq = 0;

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

    const socket = inject(SocketService);
    const doc = inject(DOCUMENT);
    merge(
      socket.on<{ id: number }>(NOTIFICATION_NEW_EVENT),
      socket.connected$,
      fromEvent(doc, 'visibilitychange').pipe(filter(() => doc.visibilityState === 'visible')),
    )
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.sync());
  }

  /** Підтягнути зміни з сервера: лічильник, а при відкритій панелі — нові згори. */
  private sync(): void {
    if (this.userId() === null) return;
    void this.refreshUnread();
    if (this._panelOpen()) void (this._loaded() ? this.mergeFirst() : this.loadFirst());
  }

  setPanelOpen(open: boolean): void {
    this._panelOpen.set(open);
  }

  async refreshUnread(): Promise<void> {
    const gen = this.generation;
    const seq = ++this.unreadSeq;
    try {
      const { count } = await firstValueFrom(this.api.unreadCount());
      if (gen === this.generation && seq === this.unreadSeq) {
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

  /**
   * Перша сторінка, підмішана згори без дублікатів; довантажене й курсор лишаються. Якщо
   * жодне сповіщення сторінки ще не відоме, а далі є ще — між ними може бути розрив, тож
   * список замінюється першою сторінкою.
   */
  private async mergeFirst(): Promise<void> {
    const gen = this.generation;
    try {
      const page = await firstValueFrom(this.api.list());
      if (gen !== this.generation) return;
      const known = new Set(this._items().map((n) => n.id));
      const fresh = page.items.filter((n) => !known.has(n.id));
      if (fresh.length === page.items.length && page.nextCursor !== null) {
        this._items.set(page.items);
        this._nextCursor.set(page.nextCursor);
        return;
      }
      const byId = new Map(page.items.map((n) => [n.id, n]));
      this._items.update((items) => [...fresh, ...items.map((n) => byId.get(n.id) ?? n)]);
    } catch {
      // Тихе оновлення: список лишається як був.
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
    this.unreadSeq++; // запит лічильника, що вже летить, не поверне старе значення
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
    // Поки летів запит, могли прийти нові — лічильник беремо з сервера.
    await this.refreshUnread();
  }

  /** Видалити сповіщення: оптимістично; при помилці — повернути список і лічильник із сервера. */
  async remove(n: NotificationDto): Promise<void> {
    const gen = this.generation;
    this._items.update((items) => items.filter((x) => x.id !== n.id));
    if (!n.readAt) {
      this.unreadSeq++;
      this._unread.update((c) => Math.max(0, c - 1));
    }
    try {
      await firstValueFrom(this.api.remove(n.id));
    } catch (err) {
      if (gen !== this.generation) return;
      // 404 — уже видалене (інша вкладка): список правильний, лічильник перечитуємо.
      if ((err as { status?: number }).status !== 404) void this.loadFirst();
      void this.refreshUnread();
    }
  }

  /** Видалити всі прочитані; список — з сервера (довантажені сторінки могли розійтися). */
  async removeRead(): Promise<void> {
    const gen = this.generation;
    try {
      await firstValueFrom(this.api.removeRead());
    } catch {
      return;
    }
    if (gen !== this.generation) return;
    this._items.update((items) => items.filter((n) => !n.readAt));
    await Promise.all([this.refreshUnread(), this._panelOpen() ? this.loadFirst() : undefined]);
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
