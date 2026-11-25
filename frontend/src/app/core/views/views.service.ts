import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal, type Signal } from '@angular/core';
import type { EntityViewType, SeenState } from '@nri/shared';

/** Дзеркало `ENTITY_VIEWS_MAX_IDS` з @nri/shared. */
export const VIEWS_MAX_IDS = 100;
/** Пауза перед `POST /api/me/views`: кілька списків на сторінці — один запит на тип. */
export const VIEWS_DEBOUNCE_MS = 1_500;

/** Бейдж елемента списку: «Нове» / «Оновлено». */
export type SeenBadge = Exclude<SeenState, 'seen'>;

/**
 * Бейджі одного списку. Стан із сервера «прилипає» до кінця перегляду сторінки: після
 * позначення переглянутим (і навіть після перечитування списку) бейдж не зникає з-під очей.
 */
export class SeenTracker {
  private readonly state = signal<ReadonlyMap<number, SeenBadge>>(new Map());
  readonly badges: Signal<ReadonlyMap<number, SeenBadge>> = this.state.asReadonly();

  constructor(
    private readonly views: ViewsService,
    private readonly type: EntityViewType,
  ) {}

  /** Показано список: запамʼятати бейджі й позначити нові/оновлені переглянутими. */
  track(items: readonly { id: number; seen?: SeenState }[]): void {
    const fresh = items.filter(
      (i): i is { id: number; seen: SeenBadge } => i.seen === 'new' || i.seen === 'updated',
    );
    if (!fresh.length) return;
    this.state.update((map) => {
      const next = new Map(map);
      for (const i of fresh) next.set(i.id, i.seen);
      return next;
    });
    this.views.mark(
      this.type,
      fresh.map((i) => i.id),
    );
  }

  badge(id: number): SeenBadge | null {
    return this.state().get(id) ?? null;
  }
}

/** `POST /api/me/views`: відкладено, пакетами до 100 id на тип. Помилки не критичні. */
@Injectable({ providedIn: 'root' })
export class ViewsService {
  private readonly http = inject(HttpClient);
  private readonly queue = new Map<EntityViewType, Set<number>>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  tracker(type: EntityViewType): SeenTracker {
    return new SeenTracker(this, type);
  }

  mark(type: EntityViewType, ids: readonly number[]): void {
    if (!ids.length) return;
    let set = this.queue.get(type);
    if (!set) this.queue.set(type, (set = new Set()));
    for (const id of ids) set.add(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), VIEWS_DEBOUNCE_MS);
  }

  /** Надіслати чергу негайно. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [entityType, set] of this.queue) {
      const ids = [...set];
      for (let i = 0; i < ids.length; i += VIEWS_MAX_IDS) {
        this.http
          .post<void>('/api/me/views', { entityType, ids: ids.slice(i, i + VIEWS_MAX_IDS) })
          .subscribe({ error: () => undefined });
      }
    }
    this.queue.clear();
  }
}
