import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import {
  SEARCH_SORTS,
  type AvailabilityDto,
  type RestrictedGameDto,
  type SearchFiltersInput,
  type SearchGameCardDto,
  type SearchResultDto,
  type SearchSort,
} from '@nri/shared';
import type { Subscription } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { AvailabilityApi } from '../../../core/availability/availability.api';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { GamesApi } from '../../../core/games/games.api';
import { viewerTimeZone } from '../../../core/i18n/dates';
import { AvailabilityEditor } from '../../calendar/availability-editor/availability-editor';
import { GameCard } from '../game-card/game-card';
import { SearchFilters, type EffectiveCalendarMode } from '../search-filters/search-filters';
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  parseSearchParams,
  resolveCalendarMode,
  toSearchParams,
  toSearchRequest,
  type CalendarRequest,
  type SearchFilterState,
} from '../search-query';

type SearchItem = SearchGameCardDto | RestrictedGameDto;

/**
 * Скільки порожніх сторінок з курсором довантажувати автоматично, перш ніж показати
 * «Показати ще» (бекенд може віддати порожню сторінку, якщо перегляд обмежено).
 */
const MAX_AUTO_CONTINUE = 2;

/** Відповідь 400 на застарілий/недійсний курсор (бекенд може скинути ключ шифрування). */
function isInvalidCursor(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse) || err.status !== 400) return false;
  const e = (err.error as { error?: { code?: unknown; details?: { reason?: unknown } } } | null)
    ?.error;
  return e?.code === 'INVALID_CURSOR' || e?.details?.reason === 'INVALID_CURSOR';
}

/**
 * Пошук ігор (вид гравця, також для гостей). Фільтри живуть у query-параметрах URL;
 * будь-яка зміна фільтра перезапускає пошук з першої сторінки. Календар «для цього
 * пошуку» (`useCustomCalendar`) лише в пам'яті — збережений календар не змінюється.
 */
@Component({
  selector: 'nri-search-page',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    AvailabilityEditor,
    GameCard,
    SearchFilters,
  ],
  templateUrl: './search-page.html',
  styleUrl: './search-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPage {
  private readonly api = inject(GamesApi);
  private readonly availabilityApi = inject(AvailabilityApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  readonly filters = computed(() => parseSearchParams(this.params()), {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  protected readonly signedIn = this.auth.isAuthenticated;
  private readonly userId = computed(() => this.auth.me()?.id);
  /** Чи є в користувача збережені слоти; `null` — ще не відомо (або гість). */
  protected readonly hasSlots = signal<boolean | null>(null);
  /** Збережений календар користувача (`null` — ще не відомо, гість або помилка). */
  private readonly savedCalendar = signal<AvailabilityDto | null>(null);
  /** Календар «для цього пошуку»: лише в пам'яті, не в URL і не на сервері. */
  private readonly customCalendar = signal<AvailabilityDto | null>(null);
  /** З чого почати редактор «для цього пошуку» (копія збереженого або порожній). */
  protected readonly customStart = signal<AvailabilityDto | null>(null);
  protected readonly customActive = computed(() => this.customCalendar() !== null);

  protected readonly calendarMode = computed<EffectiveCalendarMode>(() =>
    resolveCalendarMode({
      signedIn: this.auth.isAuthenticated(),
      custom: this.customCalendar() !== null,
      chosen: this.filters().calendar,
      hasSlots: this.hasSlots(),
    }),
  );

  /** Тіло запиту без курсора; `null` — ще визначається режим календаря. */
  private readonly request = computed<SearchFiltersInput | null>(
    () => {
      const mode = this.calendarMode();
      if (mode === null) return null;
      const custom = this.customCalendar();
      const calendar: CalendarRequest =
        mode === 'custom' && custom
          ? { mode, availability: custom }
          : { mode: mode === 'mine' ? 'mine' : 'off' };
      return toSearchRequest(this.filters(), calendar, viewerTimeZone(this.auth.me()));
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );

  protected readonly items = signal<SearchItem[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly status = signal<'loading' | 'loadingMore' | 'idle' | 'error' | 'errorMore'>(
    'loading',
  );
  /** Автодовантаження порожніх сторінок вичерпано — чекаємо на «Показати ще». */
  protected readonly paused = signal(false);
  protected readonly sorts = SEARCH_SORTS;
  protected readonly anyFilters = computed(() => hasActiveFilters(this.filters()));

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private observer: IntersectionObserver | null = null;
  private sub: Subscription | null = null;
  private base: SearchFiltersInput | null = null;
  private emptyStreak = 0;

  constructor() {
    void inject(CatalogStore).load();

    // Збережений календар — лише для залогіненого; помилка = «слотів немає».
    // Відстежуємо лише id: оновлення профілю (той самий користувач) не перезапитує календар.
    effect((onCleanup) => {
      const userId = this.userId();
      untracked(() => {
        this.hasSlots.set(null);
        this.savedCalendar.set(null);
        this.useCustomCalendar(null);
      });
      if (userId === undefined) return;
      const sub = this.availabilityApi.get().subscribe({
        next: (a) => {
          this.savedCalendar.set(a);
          this.hasSlots.set(a.slots.length > 0);
        },
        error: () => this.hasSlots.set(false),
      });
      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      const req = this.request();
      if (req) untracked(() => this.restart(req));
    });

    afterNextRender(() => this.observeSentinel());
    inject(DestroyRef).onDestroy(() => {
      this.sub?.unsubscribe();
      this.observer?.disconnect();
    });
  }

  /**
   * Пошук за календарем «лише для цього пошуку» (не зберігається, не потрапляє в URL).
   * `null` — повернутися до збереженого календаря. Точка підключення редактора (Task 12).
   */
  useCustomCalendar(availability: AvailabilityDto | null): void {
    this.customCalendar.set(availability);
    // Редактор стартує з першого застосованого календаря; подальші «Застосувати» його не скидають.
    if (!availability) this.customStart.set(null);
    else if (!this.customStart()) this.customStart.set(availability);
  }

  /** «Змінити для цього пошуку»: редактор стартує з копії збереженого календаря. */
  protected openCustomCalendar(): void {
    const start = this.savedCalendar() ?? {
      timezone: viewerTimeZone(this.auth.me()),
      slots: [],
      busyDates: [],
    };
    this.customStart.set(start);
    this.customCalendar.set(start);
  }

  /** «Скинути»: назад до збереженого календаря (`mine`), навіть якщо в URL було `cal=off`. */
  protected resetCustomCalendar(): void {
    if (this.filters().calendar !== 'off') {
      this.useCustomCalendar(null);
      return;
    }
    // Спершу прибираємо `cal=off` з URL, потім календар — один перезапуск пошуку, а не два.
    void this.navigate({ ...this.filters(), calendar: undefined }).then(() =>
      this.useCustomCalendar(null),
    );
  }

  protected onFiltersChanged(patch: Partial<SearchFilterState>): void {
    if ('calendar' in patch) this.customCalendar.set(null);
    void this.navigate({ ...this.filters(), ...patch });
  }

  protected onReset(): void {
    const f = this.filters();
    void this.navigate({
      ...EMPTY_FILTERS,
      sort: f.sort,
      calendar: f.calendar,
      includePartial: f.includePartial,
    });
  }

  protected onSort(event: Event): void {
    const sort = (event.target as HTMLSelectElement).value as SearchSort;
    void this.navigate({ ...this.filters(), sort });
  }

  private navigate(f: SearchFilterState): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toSearchParams(f),
      replaceUrl: true,
    });
  }

  protected retry(): void {
    if (this.status() === 'errorMore') this.fetch(this.nextCursor());
    else if (this.base) this.restart(this.base);
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (!cursor || this.status() !== 'idle') return;
    this.paused.set(false);
    this.emptyStreak = 0;
    this.fetch(cursor);
  }

  private restart(base: SearchFiltersInput, keepItems = false): void {
    this.base = base;
    this.emptyStreak = 0;
    this.paused.set(false);
    if (!keepItems) {
      this.items.set([]);
      this.nextCursor.set(null);
    }
    this.fetch(null, true);
  }

  private fetch(cursor: string | null, replace = false): void {
    const base = this.base;
    if (!base) return;
    this.sub?.unsubscribe();
    this.status.set(replace && this.items().length === 0 ? 'loading' : 'loadingMore');
    this.sub = this.api.search(cursor ? { ...base, cursor } : base).subscribe({
      next: (res) => this.onPage(res, replace),
      error: (err: unknown) => {
        // Курсор протух — тихо починаємо з першої сторінки, не ховаючи вже показане.
        if (cursor && isInvalidCursor(err)) this.restart(base, true);
        else this.status.set(cursor ? 'errorMore' : 'error');
      },
    });
  }

  private onPage(res: SearchResultDto, replace: boolean): void {
    if (replace) {
      this.items.set(res.items);
    } else {
      const seen = new Set(this.items().map((g) => g.id));
      const fresh = res.items.filter((g) => !seen.has(g.id));
      this.items.update((list) => [...list, ...fresh]);
    }
    this.nextCursor.set(res.nextCursor);
    this.status.set('idle');
    if (!res.nextCursor) return;
    if (res.items.length === 0) {
      // Порожня сторінка з курсором — «продовжуйте», а не «нічого не знайдено».
      if (this.emptyStreak++ < MAX_AUTO_CONTINUE) {
        this.fetch(res.nextCursor);
        return;
      }
      this.paused.set(true);
      return;
    }
    this.emptyStreak = 0;
    this.recheckSentinel();
  }

  /** Нескінченна прокрутка: коли «маяк» під списком видно — довантажуємо. */
  private observeSentinel(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !this.paused()) this.loadMore();
      },
      { rootMargin: '400px 0px' },
    );
    this.recheckSentinel();
  }

  /** Перепідписка змушує observer заново повідомити, чи «маяк» ще видно. */
  private recheckSentinel(): void {
    const el = this.sentinel()?.nativeElement;
    if (!this.observer || !el) return;
    this.observer.unobserve(el);
    this.observer.observe(el);
  }
}
