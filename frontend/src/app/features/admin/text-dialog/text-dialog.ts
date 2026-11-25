import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { MODERATION_TEXT_MAX } from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';

/** Ключі i18n і запит діалогу «дія з приміткою/причиною». */
export interface TextDialogData {
  title: string;
  /** Пояснення над полем (напр. наслідки дії). */
  text?: string;
  params?: Record<string, unknown>;
  label: string;
  /** Причина обов'язкова (інакше — необов'язкова примітка). */
  required: boolean;
  confirm: string;
  danger?: boolean;
  /** Запит із текстом (порожній після trim → `undefined`); помилки — у діалозі. */
  submit: (text: string | undefined) => Observable<unknown>;
}

function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * Підтвердження дії персоналу з текстом: відхилення скарги чи апеляції (примітка),
 * приховування тексту чи анулювання оцінки (причина), зняття санкції. Запит іде лише після
 * натискання кнопки підтвердження; закривається з відповіддю сервера.
 */
@Component({
  selector: 'nri-admin-text-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './text-dialog.html',
  styleUrl: './text-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TextDialog {
  protected readonly data = inject<TextDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<TextDialog, unknown>>(MatDialogRef);

  protected readonly max = MODERATION_TEXT_MAX;
  protected readonly text = new FormControl('', {
    nonNullable: true,
    validators: [
      ...(this.data.required ? [trimmedRequired] : []),
      Validators.maxLength(MODERATION_TEXT_MAX),
    ],
  });
  protected readonly form = new FormGroup({ text: this.text });
  private readonly value = toSignal(this.text.valueChanges, { initialValue: '' });
  protected readonly length = computed(() => this.value().length);

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.text.invalid) {
      this.text.markAsTouched();
      return;
    }
    const text = this.text.value.trim();
    this.submitting.set(true);
    try {
      this.ref.close(await firstValueFrom(this.data.submit(text || undefined)));
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }
}
