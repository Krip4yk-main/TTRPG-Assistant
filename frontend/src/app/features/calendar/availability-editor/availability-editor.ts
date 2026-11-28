import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule, type MatDatepickerInputEvent } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { AvailabilityDto } from '@nri/shared';
import { firstValueFrom, map } from 'rxjs';
import { AuthStore } from '../../../core/auth/auth.store';
import { AvailabilityApi } from '../../../core/availability/availability.api';
import { CalendarApi } from '../../../core/calendar/calendar.api';
import { formatHours } from '../../../core/i18n/duration';
import { browserTimeZone, fromIsoDate, provideUkDates, toIsoDate } from '../../../core/i18n/dates';
import {
  CELLS_PER_DAY,
  CELL_MINUTES,
  DAYS,
  WEEKDAY_EVENINGS,
  WEEKENDS,
  cellIndex,
  cellsToSlots,
  formatMinutes,
  gameBusyCells,
  gameBusyWindow,
  slotsToCells,
  withTemplate,
  type WeekTemplate,
} from './availability-grid';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Як часто оновлювати зайнятість від ігор, мс. */
const GAME_BUSY_REFRESH_MS = 5 * 60_000;
/** Найбільше зайнятих дат (обмеження бекенду). */
const MAX_BUSY_DATES = 366;
/** Крок PageUp/PageDown, клітинок (4 год). */
const PAGE_STEP = 8;
/** Клітинка, з якої починається клавіатурна навігація (Пн 18:00). */
const DEFAULT_FOCUS = cellIndex(0, 36);
/** Нижче цієї ширини режим «Фарбувати» ввімкнений одразу (телефони). */
const NARROW_QUERY = '(max-width: 767.98px)';

/** Шаблони тижня: кнопка → проміжки й повідомлення для читача екрана. */
const TEMPLATES = {
  weekdayEvenings: {
    template: WEEKDAY_EVENINGS,
    announce: 'calendar.templates.weekdayEveningsAdded',
  },
  weekends: { template: WEEKENDS, announce: 'calendar.templates.weekendsAdded' },
} satisfies Record<string, { template: WeekTemplate; announce: string }>;

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
 * - Режим «Фарбувати» (на телефоні — одразу): тап (клік) по клітинці; перший тап визначає дію
 *   («додавати» з вільної клітинки, «стирати» — з позначеної) для наступних, доки режим не
 *   вимкнуто або не натиснуто «Готово». Жодного `preventDefault` — сторінка прокручується.
 * - Шаблони «Будні вечори», «Вихідні» додаються до наявних слотів; «Очистити» — з підтвердженням.
 * - Клавіатура (клітинки — кнопки з `aria-pressed`): стрілки, Home/End, PageUp/PageDown — рух;
 *   пробіл/Enter — перемкнути;
 *   Shift+стрілка — протягнути те саме значення далі.
 * - `save`: кнопка «Зберегти» → `PUT /api/me/availability`. Сітка — у поясі акаунта (R5),
 *   змінити його можна лише в налаштуваннях акаунта; календар пояс не змінює.
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
    RouterLink,
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
  private readonly calendarApi = inject(CalendarApi);
  private readonly auth = inject(AuthStore);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly dialog = inject(MatDialog);
  private readonly announcer = inject(LiveAnnouncer);

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
  /** Режим «Фарбувати»: тапи замість протягування. */
  protected readonly paintMode = signal(
    typeof matchMedia === 'function' && !!matchMedia(NARROW_QUERY)?.matches,
  );
  /** Дія режиму «Фарбувати», визначена першим тапом: `true` — додавати, `false` — стирати. */
  protected readonly paintAction = signal<boolean | null>(null);
  /** Значення, яке Shift+стрілка «протягує» далі. */
  private paintValue = true;
  /**
   * `save`: сесії ігор («Назва, 27.11, 19:00–23:00»), що припадають на клітинку в найближчі
   * 7 днів. Лише показ —
   * вільний час вони не змінюють і не редагуються.
   */
  protected readonly gameBusy = signal<string[][]>(gameBusyCells([], 'UTC'));
  /** Пояс, для якого зайнятість уже запитано. */
  private gameBusyZone: string | null = null;

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
  /** Підказка клітинки із сесіями (по сесії на рядок) або `null`. */
  protected readonly busyTitles = computed(() =>
    this.gameBusy().map((games) => (games.length ? games.join('\n') : null)),
  );
  private readonly busyPrefix = toSignal(
    this.translate.stream('calendar.gameBusy.cell').pipe(map(String)),
    { initialValue: '' },
  );
  /** Підписи клітинок для читачів екрана: «Вівторок, 19:00–19:30. Сесія гри: …». */
  protected readonly labels = computed(() => {
    const names = this.weekdayNames();
    const busy = this.gameBusy();
    const prefix = this.busyPrefix();
    return this.days.map((d) =>
      this.rows.map((c) => {
        const base = `${names[d]}, ${this.times[c]}–${this.times[c + 1]}`;
        const games = busy[cellIndex(d, c)]!;
        return games.length ? `${base}. ${prefix}: ${games.join('; ')}` : base;
      }),
    );
  });
  protected readonly selectedCount = computed(() => this.cells().filter(Boolean).length);
  protected readonly selectedHours = computed(() => formatHours(this.selectedCount() * 30));
  protected readonly dirty = computed(() => this.serialize() !== this.snapshot());

  constructor() {
    effect(() => {
      const initial = this.initial();
      untracked(() => {
        if (initial) this.apply(initial);
        else void this.load();
      });
    });
    // Сесії переносять/скасовують, а вікно «найближчих 7 днів» зсувається з новою добою.
    const refresh = setInterval(() => {
      if (this.mode() === 'save' && this.state() === 'ready') {
        void this.loadGameBusy(this.timezone());
      }
    }, GAME_BUSY_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(refresh));
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
    // `save`: відповідь GET/PUT містить пояс акаунта. `custom`: пояс переданого календаря.
    this.timezone.set(a.timezone || this.auth.me()?.timezone || browserTimeZone());
    this.snapshot.set(this.serialize());
    this.state.set('ready');
    if (this.mode() === 'save' && this.gameBusyZone !== this.timezone()) {
      void this.loadGameBusy(this.timezone());
    }
  }

  /** Сесії ігор найближчих 7 днів у поясі акаунта; без них редактор працює як раніше. */
  private async loadGameBusy(tz: string): Promise<void> {
    this.gameBusyZone = tz;
    const { from, to } = gameBusyWindow(new Date(), tz);
    try {
      const busy = await firstValueFrom(this.calendarApi.gameBusy(from, to));
      if (this.gameBusyZone === tz) this.gameBusy.set(gameBusyCells(busy, tz));
    } catch {
      if (this.gameBusyZone === tz) this.gameBusyZone = null;
    }
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
    // У режимі «Фарбувати» — лише тапи (click): без протягування й без блокування прокрутки.
    if (event.button !== 0 || this.paintMode()) return;
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

  // ---- Режим «Фарбувати» ----

  protected togglePaintMode(): void {
    this.paintMode.update((on) => !on);
    this.paintAction.set(null);
  }

  /** «Готово»: наступний тап знову визначить дію. */
  protected paintDone(): void {
    this.paintAction.set(null);
  }

  protected onCellClick(event: MouseEvent, index: number): void {
    // `detail === 0` — клік від Enter/пробілу; клавіатуру вже обробив `onKeydown`.
    if (!this.paintMode() || event.detail === 0) return;
    let value = this.paintAction();
    if (value === null) {
      value = !this.cells()[index];
      this.paintAction.set(value);
    }
    this.paintValue = value;
    this.focused.set(index);
    this.setCell(index, value);
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
      .querySelector<HTMLElement>(`button.cell[data-day="${day}"][data-cell="${cell}"]`)
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

  protected applyTemplate(name: keyof typeof TEMPLATES): void {
    const { template, announce } = TEMPLATES[name];
    this.cells.update((cells) => withTemplate(cells, template));
    this.message.set(null);
    void this.announcer.announce(this.translate.instant(announce), 'polite');
  }

  protected async clearWeek(): Promise<void> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'calendar.clearConfirm.title',
        text: 'calendar.clearConfirm.text',
        confirm: 'calendar.clearConfirm.confirm',
        danger: true,
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.cells.set(slotsToCells([]));
    this.paintAction.set(null);
    this.message.set(null);
    void this.announcer.announce(this.translate.instant('calendar.cleared'), 'polite');
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
      const { slots, busyDates } = this.value();
      const saved = await firstValueFrom(this.api.put({ slots, busyDates }));
      this.apply(saved);
      this.message.set({ kind: 'info', key: 'calendar.saved' });
      this.changed.emit(saved);
    } catch {
      this.message.set({ kind: 'error', key: 'calendar.saveError' });
    } finally {
      this.saving.set(false);
    }
  }
}
