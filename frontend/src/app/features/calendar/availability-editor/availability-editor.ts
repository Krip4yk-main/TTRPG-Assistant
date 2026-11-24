import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule, type MatDatepickerInputEvent } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { AvailabilityDto } from '@nri/shared';
import { firstValueFrom, map } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { AvailabilityApi } from '../../../core/availability/availability.api';
import { fromIsoDate, provideUkDates, toIsoDate } from '../../../core/i18n/dates';
import {
  CELLS_PER_DAY,
  CELL_MINUTES,
  DAYS,
  cellIndex,
  cellsToSlots,
  formatMinutes,
  slotsToCells,
} from './availability-grid';

/** Найбільше зайнятих дат (обмеження бекенду). */
const MAX_BUSY_DATES = 366;
/** Крок PageUp/PageDown, клітинок (4 год). */
const PAGE_STEP = 8;
/** Клітинка, з якої починається клавіатурна навігація (Пн 18:00). */
const DEFAULT_FOCUS = cellIndex(0, 36);

interface Point {
  day: number;
  cell: number;
}

/** Виділення протягуванням: прямокутник від `from` до `to` отримує значення `value`. */
interface Drag {
  from: Point;
  to: Point;
  value: boolean;
}

let nextId = 0;

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Канонічна назва поясу (`Europe/Kyiv` і `Europe/Kiev` — той самий пояс). */
function canonicalZone(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

function inRect(d: Drag, day: number, cell: number): boolean {
  return (
    day >= Math.min(d.from.day, d.to.day) &&
    day <= Math.max(d.from.day, d.to.day) &&
    cell >= Math.min(d.from.cell, d.to.cell) &&
    cell <= Math.max(d.from.cell, d.to.cell)
  );
}

/**
 * Тижневий календар вільного часу: сітка 7 × 48 клітинок по 30 хв і список зайнятих дат.
 *
 * - Миша/перо: протягування виділяє прямокутник; почавши з вибраної клітинки — знімає виділення.
 *   Дотик: торкання перемикає клітинку (протягування пальцем лишається прокруткою).
 * - Клавіатура: стрілки, Home/End, PageUp/PageDown — рух; пробіл/Enter — перемкнути;
 *   Shift+стрілка — протягнути те саме значення далі.
 * - `save`: кнопка «Зберегти» → `PUT /api/me/availability` (змінює й пояс акаунта).
 *   `custom`: «Застосувати до пошуку» лише віддає календар через `changed`, нічого не зберігає.
 */
@Component({
  selector: 'nri-availability-editor',
  imports: [
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  providers: [provideUkDates()],
  templateUrl: './availability-editor.html',
  styleUrl: './availability-editor.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:pointerup)': 'endDrag()',
    '(document:pointercancel)': 'drag.set(null)',
  },
})
export class AvailabilityEditor {
  private readonly api = inject(AvailabilityApi);
  private readonly auth = inject(AuthStore);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** `save` — сторінка «Мій календар»; `custom` — календар лише для поточного пошуку. */
  readonly mode = input<'save' | 'custom'>('save');
  /** Початкові дані; `null` — завантажити збережений календар. */
  readonly initial = input<AvailabilityDto | null>(null);
  /** `save`: збережений календар; `custom`: календар для застосування до пошуку. */
  readonly changed = output<AvailabilityDto>();

  protected readonly uid = `nri-availability-${nextId++}`;
  protected readonly days = Array.from({ length: DAYS }, (_, d) => d);
  protected readonly rows = Array.from({ length: CELLS_PER_DAY }, (_, c) => c);
  protected readonly times = Array.from({ length: CELLS_PER_DAY + 1 }, (_, c) =>
    formatMinutes(c * CELL_MINUTES),
  );
  protected readonly browserTz = browserTimezone();
  /** Пояс пристрою відрізняється від поясу календаря — пропонуємо перейти на нього. */
  protected readonly otherBrowserTz = computed(
    () =>
      !!this.browserTz &&
      !!this.timezone() &&
      canonicalZone(this.browserTz) !== canonicalZone(this.timezone()),
  );
  protected readonly today = new Date(new Date().setHours(0, 0, 0, 0));
  protected readonly maxBusy = MAX_BUSY_DATES;

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly cells = signal<boolean[]>(slotsToCells([]));
  protected readonly busyDates = signal<string[]>([]);
  protected readonly timezone = signal('');
  protected readonly drag = signal<Drag | null>(null);
  protected readonly focused = signal(DEFAULT_FOCUS);
  protected readonly saving = signal(false);
  protected readonly message = signal<{ kind: 'error' | 'info'; key: string } | null>(null);
  /** Знімок останнього збереженого/завантаженого стану — для «є незбережені зміни». */
  private readonly snapshot = signal('');
  /** Значення, яке Shift+стрілка «протягує» далі. */
  private paintValue = true;

  private readonly weekdayNames = toSignal(
    this.translate
      .stream(this.days.map((d) => `games.weekdaysLong.${d}`))
      .pipe(map((t: Record<string, string>) => this.days.map((d) => t[`games.weekdaysLong.${d}`]))),
    { initialValue: this.days.map(String) },
  );

  /** Що показати в кожній клітинці (з урахуванням протягування, що триває). */
  protected readonly display = computed(() => {
    const d = this.drag();
    const cells = this.cells();
    if (!d) return cells;
    return cells.map((on, i) =>
      inRect(d, Math.floor(i / CELLS_PER_DAY), i % CELLS_PER_DAY) ? d.value : on,
    );
  });
  /** Підписи клітинок для читачів екрана: «Вівторок, 19:00–19:30». */
  protected readonly labels = computed(() => {
    const names = this.weekdayNames();
    return this.days.map((d) =>
      this.rows.map((c) => `${names[d]}, ${this.times[c]}–${this.times[c + 1]}`),
    );
  });
  protected readonly selectedCount = computed(() => this.cells().filter(Boolean).length);
  protected readonly dirty = computed(() => this.serialize() !== this.snapshot());

  constructor() {
    effect(() => {
      const initial = this.initial();
      untracked(() => {
        if (initial) this.apply(initial);
        else void this.load();
      });
    });
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.apply(await firstValueFrom(this.api.get()));
    } catch {
      this.state.set('error');
    }
  }

  private apply(a: AvailabilityDto): void {
    this.cells.set(slotsToCells(a.slots));
    this.busyDates.set([...a.busyDates].sort());
    this.timezone.set(a.timezone || this.auth.me()?.timezone || this.browserTz);
    this.snapshot.set(this.serialize());
    this.state.set('ready');
  }

  /** Поточний стан редактора як `AvailabilityDto`. */
  protected value(): AvailabilityDto {
    return {
      timezone: this.timezone(),
      slots: cellsToSlots(this.cells()),
      busyDates: this.busyDates(),
    };
  }

  private serialize(): string {
    return JSON.stringify(this.value());
  }

  // ---- Миша / перо / дотик ----

  protected onPointerDown(event: PointerEvent, day: number, cell: number): void {
    if (event.button !== 0) return;
    // Для миші — без виділення тексту; дотик лишаємо браузеру (прокрутка).
    if (event.pointerType !== 'touch') event.preventDefault();
    this.focusCell(cellIndex(day, cell));
    const p = { day, cell };
    this.drag.set({ from: p, to: p, value: !this.cells()[cellIndex(day, cell)] });
  }

  protected onPointerEnter(day: number, cell: number): void {
    const d = this.drag();
    if (d && (d.to.day !== day || d.to.cell !== cell)) this.drag.set({ ...d, to: { day, cell } });
  }

  protected endDrag(): void {
    const d = this.drag();
    if (!d) return;
    this.drag.set(null);
    this.paintValue = d.value;
    this.cells.update((cells) =>
      cells.map((on, i) =>
        inRect(d, Math.floor(i / CELLS_PER_DAY), i % CELLS_PER_DAY) ? d.value : on,
      ),
    );
    this.message.set(null);
  }

  // ---- Клавіатура ----

  protected onKeydown(event: KeyboardEvent): void {
    const i = this.focused();
    const day = Math.floor(i / CELLS_PER_DAY);
    const cell = i % CELLS_PER_DAY;
    const last = CELLS_PER_DAY - 1;
    let target: Point | null = null;
    switch (event.key) {
      case 'ArrowUp':
        target = { day, cell: Math.max(0, cell - 1) };
        break;
      case 'ArrowDown':
        target = { day, cell: Math.min(last, cell + 1) };
        break;
      case 'ArrowLeft':
        target = { day: Math.max(0, day - 1), cell };
        break;
      case 'ArrowRight':
        target = { day: Math.min(DAYS - 1, day + 1), cell };
        break;
      case 'Home':
        target = { day, cell: 0 };
        break;
      case 'End':
        target = { day, cell: last };
        break;
      case 'PageUp':
        target = { day, cell: Math.max(0, cell - PAGE_STEP) };
        break;
      case 'PageDown':
        target = { day, cell: Math.min(last, cell + PAGE_STEP) };
        break;
      case ' ':
      case 'Enter': {
        event.preventDefault();
        const value = !this.cells()[i];
        this.paintValue = value;
        this.setCell(i, value);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    const next = cellIndex(target.day, target.cell);
    if (event.shiftKey) this.setCell(next, this.paintValue);
    this.focusCell(next);
  }

  private setCell(index: number, value: boolean): void {
    this.cells.update((cells) => cells.map((on, i) => (i === index ? value : on)));
    this.message.set(null);
  }

  private focusCell(index: number): void {
    this.focused.set(index);
    const day = Math.floor(index / CELLS_PER_DAY);
    const cell = index % CELLS_PER_DAY;
    this.host.nativeElement
      .querySelector<HTMLElement>(`[role=gridcell][data-day="${day}"][data-cell="${cell}"]`)
      ?.focus();
  }

  // ---- Зайняті дати ----

  protected addBusy(event: MatDatepickerInputEvent<Date>, input: HTMLInputElement): void {
    const date = event.value;
    if (!date || Number.isNaN(date.getTime()) || date < this.today) return;
    const iso = toIsoDate(date);
    this.busyDates.update((list) =>
      list.includes(iso) || list.length >= MAX_BUSY_DATES ? list : [...list, iso].sort(),
    );
    input.value = '';
    this.message.set(null);
  }

  protected removeBusy(iso: string): void {
    this.busyDates.update((list) => list.filter((d) => d !== iso));
    this.message.set(null);
  }

  protected formatDate(iso: string): string {
    return new Intl.DateTimeFormat('uk-UA', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(fromIsoDate(iso));
  }

  // ---- Дії ----

  protected clearWeek(): void {
    this.cells.set(slotsToCells([]));
    this.message.set(null);
  }

  protected useBrowserTimezone(): void {
    this.timezone.set(this.browserTz);
    this.message.set(null);
  }

  protected applyCustom(): void {
    this.changed.emit(this.value());
    this.snapshot.set(this.serialize());
    this.message.set({ kind: 'info', key: 'calendar.applied' });
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.message.set(null);
    try {
      const saved = await firstValueFrom(this.api.put(this.value()));
      this.apply(saved);
      this.message.set({ kind: 'info', key: 'calendar.saved' });
      this.changed.emit(saved);
      // PUT змінює й пояс акаунта (R5) — оновлюємо /api/me.
      void this.auth.load();
    } catch {
      this.message.set({ kind: 'error', key: 'calendar.saveError' });
    } finally {
      this.saving.set(false);
    }
  }
}
