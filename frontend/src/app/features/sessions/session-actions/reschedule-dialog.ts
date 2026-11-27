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
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { localDate, windowEnd, type RescheduleSessionInput, type SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import {
  differentZones,
  formatWindow,
  fromIsoDate,
  provideUkDates,
  utcToZonedInput,
  zonedInputToUtc,
} from '../../../core/i18n/dates';
import { SessionsApi } from '../../../core/sessions/sessions.api';
import { SESSION_DURATIONS } from '../session-durations';
import { StartTimeField } from '../start-time-field/start-time-field';

export interface RescheduleDialogData {
  session: SessionDto;
  /** Пояс гри: у ньому вводяться дата й час. */
  timezone: string;
  /** Пояс глядача — для підказки, якщо відрізняється. */
  viewerTimezone: string;
}

/**
 * «Перенести сесію»: дата й час — місцевий час у поясі гри, перетворюється на UTC (ціла
 * хвилина); точний час або вікно початку «з … до …»; за бажанням — нова тривалість. Минулий
 * час відхиляється біля поля без запиту — крім уточнення (вікно → точний час) у межах
 * поточного вікна, що вже почалось: тоді можна вказати й минулий момент, коли сесія
 * фактично почалась. Закривається з оновленою `SessionDto`.
 */
@Component({
  selector: 'nri-reschedule-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
    StartTimeField,
  ],
  providers: [provideUkDates()],
  templateUrl: './reschedule-dialog.html',
  styleUrl: './reschedule-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RescheduleDialog {
  protected readonly data = inject<RescheduleDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<RescheduleDialog, SessionDto>>(MatDialogRef);
  private readonly api = inject(SessionsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly durations = SESSION_DURATIONS;
  protected readonly minDate = fromIsoDate(localDate(new Date(), this.data.timezone));
  protected readonly zoneDiffers = differentZones(this.data.timezone, this.data.viewerTimezone);

  private readonly initial = utcToZonedInput(this.data.session.startsAt, this.data.timezone);
  protected readonly form = new FormGroup({
    date: new FormControl<Date | null>(this.initial.date, { validators: [Validators.required] }),
    time: new FormControl(this.initial.time, {
      nonNullable: true,
      validators: [Validators.required],
    }),
    durationMinutes: new FormControl(this.data.session.durationMinutes, { nonNullable: true }),
    startWindowMinutes: new FormControl<number | null>(this.data.session.startWindowMinutes),
  });
  /** Знімок значень форми (контроли не сигнали) — для підписів «до» вікна. */
  protected readonly value = signal(this.form.getRawValue());

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly pastKey = 'sessions.reschedule.past';
  /** Обраний момент у поясі глядача (коли пояси різні). */
  protected readonly preview = signal<string | null>(null);

  constructor() {
    // Інший час того ж дня може бути вже в майбутньому — знімаємо позначку «минуле».
    this.form.controls.time.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      const date = this.form.controls.date;
      if (date.hasError('past')) date.updateValueAndValidity({ emitEvent: false });
    });
    this.updatePreview();
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.value.set(this.form.getRawValue());
      this.updatePreview();
    });
  }

  protected hours(minutes: number): number {
    return minutes / 60;
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
    const startsAt = zonedInputToUtc(v.date, v.time, this.data.timezone);
    if (this.form.invalid || !startsAt) {
      this.form.markAllAsTouched();
      this.focus('input[aria-invalid="true"]');
      return;
    }
    if (
      Date.parse(startsAt) <= Date.now() &&
      !this.pinsInsideWindow(startsAt, v.startWindowMinutes)
    ) {
      this.markPast();
      return;
    }
    const input: RescheduleSessionInput = { startsAt };
    if (v.durationMinutes !== this.data.session.durationMinutes) {
      input.durationMinutes = v.durationMinutes;
    }
    if (v.startWindowMinutes !== this.data.session.startWindowMinutes) {
      input.startWindowMinutes = v.startWindowMinutes;
    }
    this.submitting.set(true);
    try {
      this.ref.close(await firstValueFrom(this.api.reschedule(this.data.session.id, input)));
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

  /**
   * Уточнення часу (вікно → точний) у межах поточного вікна сесії: сервер дозволяє й минулий
   * момент (сесія вже почалась), RSVP учасників лишаються.
   */
  private pinsInsideWindow(startsAt: string, window: number | null): boolean {
    const s = this.data.session;
    if (window !== null || s.startWindowMinutes === null) return false;
    const t = Date.parse(startsAt);
    const start = new Date(s.startsAt);
    return t >= start.getTime() && t <= windowEnd(start, s.startWindowMinutes).getTime();
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

  private updatePreview(): void {
    if (!this.zoneDiffers) return;
    const v = this.form.getRawValue();
    const iso = zonedInputToUtc(v.date, v.time, this.data.timezone);
    this.preview.set(
      iso
        ? formatWindow(iso, v.startWindowMinutes, this.data.viewerTimezone, { showZone: true })
        : null,
    );
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
