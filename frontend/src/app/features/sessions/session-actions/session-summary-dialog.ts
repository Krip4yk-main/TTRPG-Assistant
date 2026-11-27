import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { SESSION_SUMMARY_MAX, type SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { SessionsApi } from '../../../core/sessions/sessions.api';

export interface SessionSummaryDialogData {
  sessionId: number;
  /** Дата й час сесії для заголовка (уже відформатовані). */
  when: string;
  summary: string | null;
  /** Підсумок уже надіслано учасникам — зміни повторно не розсилаються. */
  sent: boolean;
}

/**
 * «Редагувати підсумок» проведеної сесії (майстер): порожній — прибрати. Закривається з
 * оновленою `SessionDto`.
 */
@Component({
  selector: 'nri-session-summary-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './session-summary-dialog.html',
  styleUrl: './session-summary-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionSummaryDialog {
  protected readonly data = inject<SessionSummaryDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SessionSummaryDialog, SessionDto>>(MatDialogRef);
  private readonly api = inject(SessionsApi);

  protected readonly max = SESSION_SUMMARY_MAX;
  protected readonly form = new FormGroup({
    summary: new FormControl(this.data.summary ?? '', {
      nonNullable: true,
      validators: [Validators.maxLength(SESSION_SUMMARY_MAX)],
    }),
  });
  protected readonly summary = this.form.controls.summary;
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.summary.invalid) {
      this.summary.markAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      const dto = await firstValueFrom(
        this.api.setSummary(this.data.sessionId, { summary: this.summary.value.trim() || null }),
      );
      this.ref.close(dto);
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
