import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslatePipe } from '@ngx-translate/core';
import {
  AGE_RATINGS,
  GAME_EXPERIENCE,
  GAME_FORMATS,
  GAME_KINDS,
  GAME_LANGUAGES,
  PRICE_MODES,
  type AgeRating,
} from '@nri/shared';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import {
  MAX_RANGE_DAYS,
  dateRangeError,
  hasActiveFilters,
  type EffectiveCalendarMode,
  type SearchFilterState,
} from '../search-query';

export type { EffectiveCalendarMode };

let nextId = 0;

/**
 * Панель фільтрів пошуку. Презентаційна: віддає зміни через `changed`, стан тримає сторінка
 * (у URL). Слот `[nriCalendarExtra]` — місце для редактора календаря «для цього пошуку».
 */
@Component({
  selector: 'nri-search-filters',
  imports: [
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    TranslatePipe,
    WarningChip,
  ],
  templateUrl: './search-filters.html',
  styleUrl: './search-filters.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchFilters {
  private readonly catalogStore = inject(CatalogStore);

  readonly filters = input.required<SearchFilterState>();
  /** Календарний фільтр доступний лише з сесією. */
  readonly signedIn = input(false);
  /** Чи є в користувача збережені слоти (`null` — невідомо). */
  readonly hasSlots = input<boolean | null>(null);
  readonly calendarMode = input<EffectiveCalendarMode>('off');

  readonly changed = output<Partial<SearchFilterState>>();
  readonly resetAll = output<void>();
  /** Повернутися від календаря «для цього пошуку» до збереженого. */
  readonly customCleared = output<void>();
  /** Обрано «Змінити для цього пошуку» — сторінка відкриває редактор календаря. */
  readonly customRequested = output<void>();

  protected readonly uid = `nri-filters-${nextId++}`;
  protected readonly expanded = signal(false);

  protected readonly formats = GAME_FORMATS;
  protected readonly kinds = GAME_KINDS;
  protected readonly experiences = GAME_EXPERIENCE.filter((e) => e !== 'any');
  protected readonly languages = GAME_LANGUAGES;
  protected readonly priceModes = PRICE_MODES;
  protected readonly ageRatings = AGE_RATINGS;
  protected readonly maxRangeDays = MAX_RANGE_DAYS;

  protected readonly catalog = this.catalogStore.catalog;
  protected readonly dateError = computed(() => dateRangeError(this.filters()));
  protected readonly active = computed(() => hasActiveFilters(this.filters()));
  /** Кількість заданих груп фільтрів — для кнопки «Фільтри» на вузькому екрані. */
  protected readonly activeCount = computed(() => {
    const f = this.filters();
    return [
      f.systemIds.length,
      f.genreIds.length,
      f.format,
      f.city,
      f.kind,
      f.dateFrom || f.dateTo,
      f.priceMode !== 'any' || f.priceMax !== undefined,
      f.ageRatings.length,
      f.experience,
      f.platform,
      f.language,
      f.hasFreeSlots,
      f.excludeWarningIds.length,
    ].filter(Boolean).length;
  });

  protected patch(p: Partial<SearchFilterState>): void {
    this.changed.emit(p);
  }

  /** Значення `<select>`/`<input>`; порожнє → фільтр не задано. */
  protected value(event: Event): string | undefined {
    const v = (event.target as HTMLInputElement | HTMLSelectElement).value.trim();
    return v === '' ? undefined : v;
  }

  protected onSelect<K extends keyof SearchFilterState>(key: K, event: Event): void {
    this.patch({ [key]: this.value(event) } as Partial<SearchFilterState>);
  }

  protected onPriceMax(event: Event): void {
    const v = this.value(event);
    const n = v === undefined ? NaN : Number(v);
    this.patch({
      priceMax: Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : undefined,
    });
  }

  protected onCalendar(event: Event): void {
    const v = this.value(event);
    if (v === 'custom') this.customRequested.emit();
    else this.patch({ calendar: v === 'mine' ? 'mine' : 'off' });
  }

  protected toggleAge(rating: AgeRating, checked: boolean): void {
    const cur = this.filters().ageRatings;
    this.patch({
      ageRatings: checked ? [...cur, rating] : cur.filter((r) => r !== rating),
    });
  }

  protected toggleWarning(id: number): void {
    const cur = this.filters().excludeWarningIds;
    this.patch({
      excludeWarningIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    });
  }
}
