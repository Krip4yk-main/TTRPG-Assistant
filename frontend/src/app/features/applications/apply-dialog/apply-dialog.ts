import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import {
  FormArray,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
  type AbstractControl,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  APPLICATION_ANSWER_MAX,
  APPLICATION_CONSTRAINT_MAX,
  APPLICATION_CONSTRAINTS_MAX,
  APPLICATION_MESSAGE_MAX,
  type ApplicationCooldownDetails,
  type ApplicationDto,
  type ErrorCode,
  type SanctionActiveDetails,
  toZoned,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError, type ApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, formatTime, viewerTimeZone } from '../../../core/i18n/dates';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import { sanctionActiveDetails } from '../../../core/moderation/sanction-active';
import { SanctionActiveNotice } from '../../moderation/sanction-active-notice/sanction-active-notice';
import { ThemeService } from '../../../theming/theme.service';
import { SafetySummary } from '../../games/safety/safety-summary';
import type { SafetyView } from '../../games/safety/safety-view';

/** Дані гри, потрібні для заявки. */
export interface ApplyDialogData {
  gameId: number;
  title: string;
  /** Слаги каталожних попереджень гри. */
  warningSlugs: string[];
  customWarnings: string[];
  questions: string[];
  /** Безпека гри (інструменти, межі, завіси); нічого не заповнено — `null`/немає. */
  safety?: SafetyView | null;
}

/**
 * `exists` — сервер відповів `APPLICATION_EXISTS` (заявка вже є або глядач — учасник).
 * `announced` — успіх уже озвучено читачам екрана на старті ефекту дизайну: сторінка показує
 * своє повідомлення без повторного озвучення.
 */
/** `retryAt` з `details` помилки 409 `APPLICATION_COOLDOWN`, якщо це коректна дата; інакше `null`. */
function cooldownRetryAt(err: ApiError): string | null {
  if (err.code !== 'APPLICATION_COOLDOWN') return null;
  const at = (err.details as Partial<ApplicationCooldownDetails> | null | undefined)?.retryAt;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
}

/** Чи моменти `a` і `b` припадають на один календарний день у поясі `tz`. */
function sameDay(a: string, b: string, tz: string): boolean {
  const day = (iso: string) => {
    const z = toZoned(new Date(iso), tz);
    return `${z.year}-${z.month}-${z.day}`;
  };
  try {
    return day(a) === day(b);
  } catch {
    return false;
  }
}

export type ApplyDialogResult =
  { status: 'applied'; application: ApplicationDto; announced?: true } | { status: 'exists' };

/** Коди, що стосуються конкретного поля (показуються біля нього, а не загальним алертом). */
const FIELD_CODES = new Set<ErrorCode>(['WARNINGS_NOT_ACCEPTED', 'ANSWERS_REQUIRED']);

/**
 * Діалог заявки на гру: погодження з попередженнями (обов'язкове, якщо вони є), відповіді
 * на анкету майстра (обов'язкові), повідомлення й власні обмеження (≤ 10). Запит іде звідси,
 * тож помилки API видно в самому діалозі; закривається з `ApplyDialogResult`. Після успіху
 * діалог спершу програє ефект чинного дизайну `applicationSent`, якщо він є (напр. конверт
 * «Магіпанку»; декоративний, обмежений у часі), і лише тоді закривається — повідомлення про
 * успіх показує сторінка, як і без ефекту.
 */
@Component({
  selector: 'nri-apply-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
    WarningChip,
    SanctionActiveNotice,
    SafetySummary,
  ],
  templateUrl: './apply-dialog.html',
  styleUrl: './apply-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ApplyDialog {
  protected readonly data = inject<ApplyDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ApplyDialog, ApplyDialogResult>>(MatDialogRef);
  private readonly api = inject(ApplicationsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly themes = inject(ThemeService);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthStore);

  protected readonly limits = {
    answer: APPLICATION_ANSWER_MAX,
    message: APPLICATION_MESSAGE_MAX,
    constraint: APPLICATION_CONSTRAINT_MAX,
    constraints: APPLICATION_CONSTRAINTS_MAX,
  };
  protected readonly hasWarnings =
    this.data.warningSlugs.length > 0 || this.data.customWarnings.length > 0;

  protected readonly form = new FormGroup({
    accepted: new FormControl(false, {
      nonNullable: true,
      validators: this.hasWarnings ? [Validators.requiredTrue] : [],
    }),
    answers: new FormArray(
      this.data.questions.map(
        () =>
          new FormControl('', {
            nonNullable: true,
            validators: [
              Validators.required,
              Validators.pattern(/\S/),
              Validators.maxLength(APPLICATION_ANSWER_MAX),
            ],
          }),
      ),
    ),
    message: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(APPLICATION_MESSAGE_MAX)],
    }),
    constraints: new FormArray<FormControl<string>>([]),
  });

  protected readonly submitting = signal(false);
  /** Загальна помилка API (ключ i18n). */
  protected readonly error = signal<string | null>(null);
  /** Параметри тексту загальної помилки (кулдаун — `time`). */
  protected readonly errorParams = signal<Record<string, string>>({});
  /** Відмова через санкцію (409 `SANCTION_ACTIVE`): пояснення з датою замість загальної помилки. */
  protected readonly sanction = signal<SanctionActiveDetails | null>(null);
  /** Помилка поля від сервера (на випадок розбіжності з клієнтською перевіркою). */
  protected readonly serverField = signal<ErrorCode | null>(null);
  protected readonly submitted = signal(false);

  constructor() {
    // Чанк ефекту — наперед, поки гравець заповнює форму.
    this.themes.preloadEffect('applicationSent');
  }

  protected get answers(): FormArray<FormControl<string>> {
    return this.form.controls.answers;
  }
  protected get constraints(): FormArray<FormControl<string>> {
    return this.form.controls.constraints;
  }

  /** Ключ помилки контролу, якщо його вже варто показувати. */
  protected errorKey(control: AbstractControl, requiredKey: string): string | null {
    if (!control.invalid || !(control.touched || this.submitted())) return null;
    if (control.hasError('maxlength')) return 'games.applications.apply.tooLong';
    return requiredKey;
  }

  /** Помилка погодження: клієнтська перевірка або `WARNINGS_NOT_ACCEPTED` від сервера. */
  protected acceptError(): boolean {
    const c = this.form.controls.accepted;
    return (
      (c.invalid && (c.touched || this.submitted())) ||
      this.serverField() === 'WARNINGS_NOT_ACCEPTED'
    );
  }

  protected addConstraint(): void {
    if (this.constraints.length >= APPLICATION_CONSTRAINTS_MAX) return;
    this.constraints.push(
      new FormControl('', {
        nonNullable: true,
        validators: [
          Validators.required,
          Validators.pattern(/\S/),
          Validators.maxLength(APPLICATION_CONSTRAINT_MAX),
        ],
      }),
    );
    const index = this.constraints.length - 1;
    this.focus(`input.constraint[data-index="${index}"]`);
  }

  /** Мої збережені межі з профілю (порожньо — кнопку підстановки не показуємо). */
  protected get myLimits(): string[] {
    return this.auth.me()?.myLimits ?? [];
  }

  /**
   * Додає збережені межі до наявних обмеження без дублікатів; нічого не надсилає. Порожні рядки
   * заповнюються першими (щоб не лишити порожніх обов'язкових), решта — нові рядки.
   * Кількість підставлених озвучується читачам екрана.
   */
  protected insertMyLimits(): void {
    const present = new Set(this.constraints.controls.map((c) => c.value.trim()));
    const empty = this.constraints.controls.filter((c) => c.value.trim() === '');
    let inserted = 0;
    for (const limit of this.myLimits) {
      if (present.has(limit)) continue;
      const blank = empty.shift();
      if (blank) {
        blank.setValue(limit);
      } else if (this.constraints.length < APPLICATION_CONSTRAINTS_MAX) {
        this.constraints.push(
          new FormControl(limit, {
            nonNullable: true,
            validators: [
              Validators.required,
              Validators.pattern(/\S/),
              Validators.maxLength(APPLICATION_CONSTRAINT_MAX),
            ],
          }),
        );
      } else {
        break;
      }
      present.add(limit);
      inserted++;
    }
    void this.announcer.announce(
      this.translate.instant('myLimits.inserted', { count: inserted }) as string,
      'polite',
    );
  }

  protected removeConstraint(index: number): void {
    this.constraints.removeAt(index);
    this.focus('button.add-constraint');
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.submitted.set(true);
    this.error.set(null);
    this.errorParams.set({});
    this.sanction.set(null);
    this.serverField.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.focus('input[aria-invalid="true"], textarea[aria-invalid="true"], .accept-error');
      return;
    }
    const v = this.form.getRawValue();
    const message = v.message.trim();
    this.submitting.set(true);
    try {
      const application = await firstValueFrom(
        this.api.apply(this.data.gameId, {
          warningsAccepted: v.accepted,
          answers: v.answers.map((a) => a.trim()),
          message: message || null,
          constraints: v.constraints.map((c) => c.trim()),
        }),
      );
      const announced = await this.playSent();
      this.ref.close({ status: 'applied', application, ...(announced && { announced }) });
    } catch (err) {
      const apiError = toApiError(err);
      const { code } = apiError;
      if (code === 'APPLICATION_EXISTS') {
        this.ref.close({ status: 'exists' });
        return;
      }
      const sanction = sanctionActiveDetails(apiError);
      if (code === 'APPLICATION_COOLDOWN') {
        // Час — у поясі глядача, без позначки поясу: сьогодні — «HH:mm», інший день (після
        // відхилення — майже завжди завтра) — з датою; без коректного `retryAt` — «трохи згодом».
        const retryAt = cooldownRetryAt(apiError);
        if (retryAt) {
          const tz = viewerTimeZone(this.auth.me());
          const time = sameDay(retryAt, new Date().toISOString(), tz)
            ? formatTime(retryAt, tz)
            : formatDateTime(retryAt, tz);
          this.errorParams.set({ time });
          this.error.set('errors.APPLICATION_COOLDOWN');
        } else {
          this.error.set('games.applications.apply.cooldownSoon');
        }
      } else if (sanction) {
        this.sanction.set(sanction);
      } else if (FIELD_CODES.has(code)) {
        this.serverField.set(code);
        this.focus('.server-field-error');
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }

  /**
   * Ефект надсилання (якщо є): заявку вже прийнято, тож поки ефект грає, діалог не
   * закривається Escape чи кліком поза ним — інакше успіх загубився б. Ефект ніколи не
   * відхиляється. Оверлей ефекту декоративний (`aria-hidden`), а діалог під ним прихований,
   * тож про успіх одразу на старті ввічливо повідомляє `LiveAnnouncer` (його регіон CDK
   * відкриває й модальним діалогам). `true` — ефект стартував (успіх озвучено).
   */
  private async playSent(): Promise<boolean> {
    const host = this.host.nativeElement;
    const surface = host.closest<HTMLElement>('.mat-mdc-dialog-surface') ?? host;
    let started = false;
    await this.themes.playEffect('applicationSent', surface, () => {
      started = true;
      this.ref.disableClose = true;
      void this.announcer.announce(
        this.translate.instant('games.applications.apply.sent') as string,
        'polite',
      );
    });
    return started;
  }

  /** Фокус на елементі після рендеру (перший збіг). */
  private focus(selector: string): void {
    afterNextRender(
      () => {
        const el = this.host.nativeElement.querySelector<HTMLElement>(selector);
        if (el?.classList.contains('accept-error')) {
          this.host.nativeElement.querySelector<HTMLElement>('.accept input')?.focus();
        } else {
          el?.focus();
        }
      },
      { injector: this.injector },
    );
  }
}
