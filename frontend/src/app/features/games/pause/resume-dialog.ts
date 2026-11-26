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
import {
  localDate,
  weekdayOf,
  type GameDto,
  type GameTransitionDto,
  type Recurrence,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { GamesApi } from '../../../core/games/games.api';
import {
  differentZones,
  formatDateTime,
  fromIsoDate,
  provideUkDates,
  utcToZonedInput,
  zonedInputToUtc,
} from '../../../core/i18n/dates';

export interface ResumeDialogData {
  game: Pick<
    GameDto,
    | 'id'
    | 'title'
    | 'timezone'
    | 'startsAt'
    | 'recurrence'
    | 'weekdays'
    | 'minPlayers'
    | 'maxPlayers'
    | 'freeSlots'
  >;
  /** `true` — «Оголосити донабір» (кампейн знову приймає заявки); `false` — «Відновити». */
  recruit: boolean;
  /**
   * Кампейн ще не стартував (пауза почалась у наборі, `startedAt === null`): відновлення — це
   * й перший старт, бекенд попереджає `BELOW_MIN_PLAYERS`, тож і діалог показує попередження.
   */
  firstStart: boolean;
  /** Пояс глядача — для підказки, якщо відрізняється від поясу гри. */
  viewerTimezone: string;
  /** Перед запитом (напр. приглушити власні пінги змін, що прийдуть раніше за відповідь). */
  beforeRequest?: () => void;
}

const isWeekly = (r: Recurrence) => r === 'weekly' || r === 'biweekly';

/**
 * «Відновити» / «Оголосити донабір» після паузи: дата й час першої сесії (місцевий час у
 * поясі гри, лише в майбутньому; для щотижневого правила — один із його днів). Далі розклад
 * іде за наявним правилом. Минулий час позначається біля поля (і з відповіді `GAME_IN_PAST`).
 * Закривається з `GameTransitionDto` (може містити `warning: 'BELOW_MIN_PLAYERS'`).
 */
@Component({
  selector: 'nri-resume-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  providers: [provideUkDates()],
  templateUrl: './resume-dialog.html',
  styleUrl: './resume-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResumeDialog {
  protected readonly data = inject<ResumeDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ResumeDialog, GameTransitionDto>>(MatDialogRef);
  private readonly api = inject(GamesApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  private readonly tz = this.data.game.timezone;
  protected readonly mode = this.data.recruit ? 'recruit' : 'resume';
  protected readonly titleKey = `games.pause.${this.mode}.title`;
  protected readonly minDate = fromIsoDate(localDate(new Date(), this.tz));
  protected readonly zoneDiffers = differentZones(this.tz, this.data.viewerTimezone);
  /** Дні правила, на які може припасти перша сесія; порожньо — будь-який день. */
  protected readonly ruleDays: readonly number[] = isWeekly(this.data.game.recurrence)
    ? [...this.data.game.weekdays].sort((a, b) => a - b)
    : [];
  /** Перший старт з меншою за мінімум кількістю учасників — попередження (як перед «Почати»). */
  protected readonly members = this.data.game.maxPlayers - this.data.game.freeSlots;
  protected readonly belowMin = this.data.firstStart && this.members < this.data.game.minPlayers;

  private readonly start = this.initialStart();
  protected readonly form = new FormGroup({
    date: new FormControl<Date | null>(this.start.date, { validators: [Validators.required] }),
    time: new FormControl(this.start.time, {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Обраний момент у поясі глядача (коли пояси різні), без назви поясу. */
  protected readonly preview = signal<string | null>(null);

  constructor() {
    // Інший час того ж дня може бути вже в майбутньому — знімаємо позначку «минуле».
    this.form.controls.time.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      const date = this.form.controls.date;
      if (date.hasError('past')) date.updateValueAndValidity({ emitEvent: false });
    });
    this.updatePreview();
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => this.updatePreview());
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    const v = this.form.getRawValue();
    // Дата раніше за мінімум datepicker-а — це «минуле», а не «порожнє поле».
    if (this.form.controls.date.hasError('matDatepickerMin')) {
      this.markDate('past');
      return;
    }
    const startsAt = zonedInputToUtc(v.date, v.time, this.tz);
    if (this.form.invalid || !startsAt || !v.date) {
      this.form.markAllAsTouched();
      this.focus('input[aria-invalid="true"]');
      return;
    }
    if (Date.parse(startsAt) <= Date.now()) {
      this.markDate('past');
      return;
    }
    if (this.ruleDays.length && !this.ruleDays.includes(this.weekdayOfDate(v.date))) {
      this.markDate('weekday');
      return;
    }
    this.submitting.set(true);
    this.data.beforeRequest?.();
    try {
      const dto = await firstValueFrom(
        this.api.resume(this.data.game.id, { startsAt, recruit: this.data.recruit }),
      );
      this.ref.close(dto);
    } catch (err) {
      const { code, details } = toApiError(err);
      if (code === 'GAME_IN_PAST') {
        this.markDate('past');
      } else if (code === 'VALIDATION' && touchesWeekdays(details)) {
        this.markDate('weekday');
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  /** Дата в минулому чи поза днями правила: помилка біля поля (mat-error, aria-invalid). */
  private markDate(error: 'past' | 'weekday'): void {
    const date = this.form.controls.date;
    date.setErrors({ ...date.errors, [error]: true });
    date.markAsTouched();
    this.focus('input.date');
  }

  /**
   * Типова перша сесія: найближчий день правила, починаючи із завтра (у поясі гри), о часі
   * правила; без днів правила — за тиждень.
   */
  private initialStart(): { date: Date; time: string } {
    const { time } = utcToZonedInput(this.data.game.startsAt, this.tz);
    const today = fromIsoDate(localDate(new Date(), this.tz));
    const day = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    for (let n = 1; n <= 7 && this.ruleDays.length; n++) {
      if (this.ruleDays.includes(this.weekdayOfDate(day(n)))) return { date: day(n), time };
    }
    return { date: day(7), time };
  }

  /** День тижня (0 = пн) календарної дати з datepicker-а. */
  private weekdayOfDate(date: Date): number {
    return weekdayOf(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  private updatePreview(): void {
    if (!this.zoneDiffers) return;
    const v = this.form.getRawValue();
    const iso = zonedInputToUtc(v.date, v.time, this.tz);
    this.preview.set(iso ? formatDateTime(iso, this.data.viewerTimezone) : null);
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}

/** Помилка валідації торкається днів правила (zod issue з path `['weekdays']`). */
function touchesWeekdays(details: unknown): boolean {
  return (
    Array.isArray(details) &&
    details.some((issue: unknown) => {
      const path = (issue as { path?: unknown } | null)?.path;
      return Array.isArray(path) && path[0] === 'weekdays';
    })
  );
}
