import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { MIN_REGISTRATION_AGE, completeProfileSchema, type ErrorCode } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthApi } from '../../../core/auth/auth.api';
import { AuthStore } from '../../../core/auth/auth.store';
import { provideUkDates, toIsoDate } from '../../../core/i18n/dates';
import {
  eagerErrorState,
  minAgeValidatorFor,
  nicknameValidator,
  timezoneValidator,
} from '../../../shared/forms/profile-validators';

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kyiv';
  } catch {
    return 'Europe/Kyiv';
  }
}

function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Kyiv'];
  }
}

@Component({
  selector: 'nri-complete-profile',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  providers: [provideUkDates()],
  templateUrl: './complete-profile.html',
  styleUrl: './complete-profile.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CompleteProfile {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  private readonly timezoneControl = new FormControl(defaultTimezone(), {
    nonNullable: true,
    validators: [Validators.required, timezoneValidator],
  });

  readonly form = new FormGroup({
    nickname: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, nicknameValidator],
    }),
    birthDate: new FormControl<Date | null>(null, [
      Validators.required,
      minAgeValidatorFor(() => this.timezoneControl.value),
    ]),
    timezone: this.timezoneControl,
  });

  protected readonly minAge = MIN_REGISTRATION_AGE;
  protected readonly maxBirthDate = new Date();
  protected readonly timezones = supportedTimezones();
  protected readonly errorState = eagerErrorState;
  protected readonly submitting = signal(false);
  /** Загальна помилка форми (не прив'язана до поля). */
  protected readonly formError = signal<ErrorCode | null>(null);
  /** Сигнал статусу форми — щоб OnPush-шаблон оновлював кнопку. */
  protected readonly status = toSignal(this.form.statusChanges, { initialValue: this.form.status });

  constructor() {
    // Вік залежить від поясу («сьогодні» у поясі користувача): перевіряємо заново.
    this.form.controls.timezone.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.form.controls.birthDate.updateValueAndValidity());
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) return;
    const raw = this.form.getRawValue();
    const parsed = completeProfileSchema.safeParse({
      nickname: raw.nickname.trim(),
      birthDate: raw.birthDate ? toIsoDate(raw.birthDate) : '',
      timezone: raw.timezone,
    });
    if (!parsed.success) {
      this.formError.set('VALIDATION');
      return;
    }

    this.submitting.set(true);
    this.formError.set(null);
    try {
      const me = await firstValueFrom(this.api.completeProfile(parsed.data));
      this.auth.setMe(me);
      await this.router.navigateByUrl('/');
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'NICKNAME_TAKEN') {
        const nickname = this.form.controls.nickname;
        nickname.setErrors({ ...nickname.errors, taken: true });
        nickname.markAsTouched();
      } else if (code === 'AGE_TOO_LOW') {
        // Бекенд відхилив реєстрацію й знищив сесію.
        this.auth.setMe(null);
        await this.router.navigate(['/login'], { queryParams: { error: 'AGE_TOO_LOW' } });
      } else if (code !== 'UNAUTHENTICATED') {
        // 401 обробляє authInterceptor (очищення стану й перехід на /login).
        this.formError.set(code);
      }
    } finally {
      this.submitting.set(false);
    }
  }
}
