import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { SESSION_CANCEL_REASON_MAX, type SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { SessionsApi } from '../../../core/sessions/sessions.api';

export interface CancelSessionDialogData {
  sessionId: number;
  /** Дата й час сесії для заголовка (уже відформатовані). */
  when: string;
}

/** «Скасувати сесію» з причиною (обов'язкова); закривається з оновленою `SessionDto`. */
@Component({
  selector: 'nri-cancel-session-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './cancel-session-dialog.html',
  styleUrl: './cancel-session-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CancelSessionDialog {
  protected readonly data = inject<CancelSessionDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<CancelSessionDialog, SessionDto>>(MatDialogRef);
  private readonly api = inject(SessionsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly max = SESSION_CANCEL_REASON_MAX;
  protected readonly form = new FormGroup({
    reason: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/\S/),
        Validators.maxLength(SESSION_CANCEL_REASON_MAX),
      ],
    }),
  });
  protected readonly reason = this.form.controls.reason;
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.reason.invalid) {
      this.reason.markAsTouched();
      afterNextRender(() => this.host.nativeElement.querySelector('textarea')?.focus(), {
        injector: this.injector,
      });
      return;
    }
    this.submitting.set(true);
    try {
      const dto = await firstValueFrom(
        this.api.cancel(this.data.sessionId, { reason: this.reason.value.trim() }),
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
