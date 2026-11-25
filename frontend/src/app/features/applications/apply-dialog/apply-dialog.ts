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
import { TranslatePipe } from '@ngx-translate/core';
import {
  APPLICATION_ANSWER_MAX,
  APPLICATION_CONSTRAINT_MAX,
  APPLICATION_CONSTRAINTS_MAX,
  APPLICATION_MESSAGE_MAX,
  type ApplicationDto,
  type ErrorCode,
  type SanctionActiveDetails,
} from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ApplicationsApi } from '../../../core/applications/applications.api';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import { sanctionActiveDetails } from '../../../core/moderation/sanction-active';
import { SanctionActiveNotice } from '../../moderation/sanction-active-notice/sanction-active-notice';

/** Дані гри, потрібні для заявки. */
export interface ApplyDialogData {
  gameId: number;
  title: string;
  /** Слаги каталожних попереджень гри. */
  warningSlugs: string[];
  customWarnings: string[];
  questions: string[];
}

/** `exists` — сервер відповів `APPLICATION_EXISTS` (заявка вже є або глядач — учасник). */
export type ApplyDialogResult =
  { status: 'applied'; application: ApplicationDto } | { status: 'exists' };

/** Коди, що стосуються конкретного поля (показуються біля нього, а не загальним алертом). */
const FIELD_CODES = new Set<ErrorCode>(['WARNINGS_NOT_ACCEPTED', 'ANSWERS_REQUIRED']);

/**
 * Діалог заявки на гру: погодження з попередженнями (обов'язкове, якщо вони є), відповіді
 * на анкету майстра (обов'язкові), повідомлення й власні обмеження (≤ 10). Запит іде звідси,
 * тож помилки API видно в самому діалозі; закривається з `ApplyDialogResult`.
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
  /** Відмова через санкцію (409 `SANCTION_ACTIVE`): пояснення з датою замість загальної помилки. */
  protected readonly sanction = signal<SanctionActiveDetails | null>(null);
  /** Помилка поля від сервера (на випадок розбіжності з клієнтською перевіркою). */
  protected readonly serverField = signal<ErrorCode | null>(null);
  protected readonly submitted = signal(false);

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

  protected removeConstraint(index: number): void {
    this.constraints.removeAt(index);
    this.focus('button.add-constraint');
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.submitted.set(true);
    this.error.set(null);
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
      this.ref.close({ status: 'applied', application });
    } catch (err) {
      const apiError = toApiError(err);
      const { code } = apiError;
      if (code === 'APPLICATION_EXISTS') {
        this.ref.close({ status: 'exists' });
        return;
      }
      const sanction = sanctionActiveDetails(apiError);
      if (sanction) {
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
