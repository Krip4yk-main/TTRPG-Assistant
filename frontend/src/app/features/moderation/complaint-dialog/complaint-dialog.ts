import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import { COMPLAINT_REASONS, MODERATION_TEXT_MAX, type ComplaintReason } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { ModerationApi } from '../../../core/moderation/moderation.api';

/** Ціль скарги: людина (`publicId`) або гра; `name` — нік чи назва для заголовка. */
export type ComplaintDialogData =
  { kind: 'user'; publicId: string; name: string } | { kind: 'game'; gameId: number; name: string };

/**
 * Діалог скарги: причина зі списку (обов'язкова) і необов'язковий опис (≤ 2000). Чи можна
 * скаржитись, вирішує бекенд: 403 `COMPLAINT_NOT_ALLOWED` показується в діалозі. Запит іде
 * звідси; закривається з `true` після надсилання.
 */
@Component({
  selector: 'nri-complaint-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
  ],
  templateUrl: './complaint-dialog.html',
  styleUrl: './complaint-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComplaintDialog {
  protected readonly data = inject<ComplaintDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ComplaintDialog, boolean>>(MatDialogRef);
  private readonly api = inject(ModerationApi);

  protected readonly reasons = COMPLAINT_REASONS;
  protected readonly max = MODERATION_TEXT_MAX;

  protected readonly form = new FormGroup({
    reason: new FormControl<ComplaintReason | null>(null, { validators: [Validators.required] }),
    message: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(MODERATION_TEXT_MAX)],
    }),
  });
  private readonly messageValue = toSignal(this.form.controls.message.valueChanges, {
    initialValue: '',
  });
  protected readonly length = computed(() => this.messageValue().length);

  protected readonly submitting = signal(false);
  /** Помилка API (ключ i18n). */
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { reason, message } = this.form.getRawValue();
    const target =
      this.data.kind === 'user'
        ? { targetUserId: this.data.publicId }
        : { targetGameId: this.data.gameId };
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.api.complain({ ...target, reason: reason!, message: message.trim() }),
      );
      this.ref.close(true);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close(false);
  }
}
