import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';
import { ReactiveFormsModule, type FormControl } from '@angular/forms';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { merge } from 'rxjs';
import {
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_WINDOW_START,
  snapToWindowStep,
  WINDOW_START_TIMES,
  windowEndOptions,
} from './start-window';

let nextId = 0;

/**
 * Час початку сесії: перемикач «Точний час / Приблизно». Точний — поле `HH:mm`; приблизний —
 * вікно «з» (крок 30 хв) і «до» (30 хв … 12 год після «з», може бути вже наступного дня).
 * Значення — у контролах батьківської форми: `time` (`HH:mm`, для вікна — його початок) і
 * `window` (ширина вікна, хв; `null` — точний час). Дату для підписів «до» передає батько.
 */
@Component({
  selector: 'nri-start-time-field',
  imports: [
    ReactiveFormsModule,
    MatButtonToggleModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './start-time-field.html',
  styleUrl: './start-time-field.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartTimeField {
  readonly time = input.required<FormControl<string>>();
  readonly window = input.required<FormControl<number | null>>();
  /** Календарна дата старту (datepicker): для справжнього часу кінця й «наступного дня». */
  readonly date = input<Date | null>(null);
  /** Пояс гри: у ньому задано час. */
  readonly timezone = input.required<string>();
  readonly required = input(true);
  /** Ключ підпису поля точного часу. */
  readonly label = input('games.form.startTime');
  /** Підказка під полем часу (уже перекладена). */
  readonly hint = input<string | null>(null);
  /** Ключ помилки біля часу (або «з»); `null` — немає. */
  readonly timeError = input<string | null>(null);

  protected readonly uid = `start-time-${++nextId}`;
  protected readonly starts = WINDOW_START_TIMES;
  /** Знімок контролів (вони не сигнали): значення й чи вимкнено. */
  private readonly state = signal({ time: '', window: null as number | null, disabled: false });

  protected readonly approx = computed(() => this.state().window !== null);
  protected readonly disabled = computed(() => this.state().disabled);
  /** «З» поза сіткою 30 хв (порожнє) — порожній варіант у списку. */
  protected readonly offGrid = computed(() => !this.starts.includes(this.state().time));
  protected readonly ends = computed(() =>
    windowEndOptions(this.date(), this.state().time, this.timezone()),
  );

  constructor() {
    effect((onCleanup) => {
      const time = this.time();
      const window = this.window();
      const sync = () => {
        // Приблизний час: «з» лише на сітці 30 хв — інакше в списку його не видно, а
        // надіслалося б приховане значення (напр. 19:15 з точного режиму чи з сервера).
        const snapped = window.value !== null ? snapToWindowStep(time.value) : null;
        if (snapped !== null && snapped !== time.value) time.setValue(snapped);
        this.state.set({ time: time.value, window: window.value, disabled: window.disabled });
      };
      sync();
      const sub = merge(time.events, window.events).subscribe(sync);
      onCleanup(() => sub.unsubscribe());
    });
  }

  protected hours(minutes: number): number {
    return minutes / 60;
  }

  /** Перемикач: приблизний час — вікно типової ширини з початком на сітці 30 хв. */
  protected setMode(approx: boolean): void {
    const window = this.window();
    if (approx === (window.value !== null)) return;
    // «З» округлюється вниз до 30 хв у `sync`; без часу — типовий вечір, щоб «з» і «до» були
    // справжніми годинами, а не порожнім полем із підписом «через N год».
    if (approx && !this.time().value) this.time().setValue(DEFAULT_WINDOW_START);
    window.setValue(approx ? DEFAULT_WINDOW_MINUTES : null);
    window.markAsDirty();
  }
}
