import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import {
  localDate,
  RECURRENCES,
  weekdayOf,
  type GameDto,
  type Recurrence,
  type ScheduleRuleInput,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { GamesApi } from '../../../core/games/games.api';
import {
  fromIsoDate,
  provideUkDates,
  utcToZonedInput,
  zonedInputToUtc,
} from '../../../core/i18n/dates';
import { SESSION_DURATIONS } from '../session-durations';

export interface ScheduleRuleDialogData {
  game: Pick<
    GameDto,
    | 'id'
    | 'kind'
    | 'timezone'
    | 'startsAt'
    | 'nextSessionAt'
    | 'durationMinutes'
    | 'recurrence'
    | 'weekdays'
  >;
  /** `schedule` — нове правило кампанії; `convert` — ваншот → кампанія. */
  mode: 'schedule' | 'convert';
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const isWeekly = (r: Recurrence) => r === 'weekly' || r === 'biweekly';

/**
 * Нове правило розкладу («Змінити розклад» для кампанії, «Перетворити на кампанію» для
 * ваншота): перша сесія (дата й час у поясі гри, лише в майбутньому — сервер інакше
 * відповідає `GAME_IN_PAST`), тривалість, регулярність і дні тижня. Перенесені й завершені
 * сесії правило не чіпає. Закривається з оновленою `GameDto`.
 */
@Component({
  selector: 'nri-schedule-rule-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  providers: [provideUkDates()],
  templateUrl: './schedule-rule-dialog.html',
  styleUrl: './schedule-rule-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScheduleRuleDialog {
  protected readonly data = inject<ScheduleRuleDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ScheduleRuleDialog, GameDto>>(MatDialogRef);
  private readonly api = inject(GamesApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly durations = SESSION_DURATIONS;
  protected readonly weekdays = WEEKDAYS;
  protected readonly convert = this.data.mode === 'convert';
  /** У перетворенні ваншот стає регулярною кампанією — «без повторення» немає. */
  protected readonly recurrences = this.convert
    ? RECURRENCES.filter((r) => r !== 'none')
    : RECURRENCES;
  private readonly tz = this.data.game.timezone;
  protected readonly minDate = fromIsoDate(localDate(new Date(), this.tz));

  private readonly start = this.initialStart();
  private readonly startRecurrence: Recurrence = this.convert
    ? 'weekly'
    : this.data.game.recurrence;
  protected readonly form = new FormGroup({
    date: new FormControl<Date | null>(this.start.date, { validators: [Validators.required] }),
    time: new FormControl(this.start.time, {
      nonNullable: true,
      validators: [Validators.required],
    }),
    durationMinutes: new FormControl(this.data.game.durationMinutes, { nonNullable: true }),
    recurrence: new FormControl<Recurrence>(this.startRecurrence, { nonNullable: true }),
    weekdays: new FormControl<number[]>(
      isWeekly(this.startRecurrence)
        ? this.data.game.weekdays.length
          ? [...this.data.game.weekdays]
          : [this.weekdayOfDate(this.start.date)]
        : [],
      { nonNullable: true },
    ),
  });
  protected readonly value = signal(this.form.getRawValue());

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pastKey = 'sessions.rule.past';
  protected readonly weekdaysError = signal<string | null>(null);

  constructor() {
    // Інший час того ж дня може бути вже в майбутньому — знімаємо позначку «минуле».
    this.form.controls.time.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      const date = this.form.controls.date;
      if (date.hasError('past')) date.updateValueAndValidity({ emitEvent: false });
    });
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.value.set(this.form.getRawValue());
      this.weekdaysError.set(null);
    });
    // Щотижнева регулярність без днів → підставляємо день першої сесії.
    this.form.controls.recurrence.valueChanges.pipe(takeUntilDestroyed()).subscribe((r) => {
      const date = this.form.controls.date.value;
      if (isWeekly(r) && this.form.controls.weekdays.value.length === 0 && date) {
        this.form.controls.weekdays.setValue([this.weekdayOfDate(date)]);
      }
    });
  }

  protected hours(minutes: number): number {
    return minutes / 60;
  }

  protected isWeekly(r: Recurrence): boolean {
    return isWeekly(r);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    const v = this.form.getRawValue();
    // Дата раніше за мінімум datepicker-а — це «минуле», а не «порожнє поле».
    if (this.form.controls.date.hasError('matDatepickerMin')) {
      this.markPast();
      return;
    }
    const startsAt = zonedInputToUtc(v.date, v.time, this.tz);
    if (this.form.invalid || !startsAt || !v.date) {
      this.form.markAllAsTouched();
      this.focus('input[aria-invalid="true"]');
      return;
    }
    if (Date.parse(startsAt) <= Date.now()) {
      this.markPast();
      return;
    }
    const weekly = isWeekly(v.recurrence);
    if (weekly && !v.weekdays.includes(this.weekdayOfDate(v.date))) {
      this.weekdaysError.set('sessions.rule.weekdaysError');
      this.focus('.weekdays button');
      return;
    }
    const input: ScheduleRuleInput = {
      startsAt,
      durationMinutes: v.durationMinutes,
      recurrence: v.recurrence,
      weekdays: weekly ? [...v.weekdays].sort((a, b) => a - b) : [],
    };
    this.submitting.set(true);
    try {
      const id = this.data.game.id;
      const request = this.convert
        ? this.api.convertToCampaign(id, input)
        : this.api.changeSchedule(id, input);
      this.ref.close(await firstValueFrom(request));
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'GAME_IN_PAST') {
        this.markPast();
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
      this.submitting.set(false);
    }
  }

  /** Момент у минулому: помилка біля поля дати (mat-error, aria-invalid) і фокус на ньому. */
  private markPast(): void {
    const date = this.form.controls.date;
    date.setErrors({ ...date.errors, past: true });
    date.markAsTouched();
    this.focus('input.date');
  }

  protected cancel(): void {
    this.ref.close();
  }

  /**
   * Перша сесія нового правила: найближча майбутня сесія або перша сесія гри, якщо вони в
   * майбутньому; інакше — за тиждень від сьогодні в той самий час (у поясі гри).
   */
  private initialStart(): { date: Date; time: string } {
    const g = this.data.game;
    const now = Date.now();
    const future = [g.nextSessionAt, g.startsAt].find(
      (iso): iso is string => !!iso && Date.parse(iso) > now,
    );
    if (future) return utcToZonedInput(future, this.tz);
    const { time } = utcToZonedInput(g.startsAt, this.tz);
    const today = fromIsoDate(localDate(new Date(), this.tz));
    return { date: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7), time };
  }

  /** День тижня (0 = пн) календарної дати з datepicker-а. */
  private weekdayOfDate(date: Date): number {
    return weekdayOf(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
