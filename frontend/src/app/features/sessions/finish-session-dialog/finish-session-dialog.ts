import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { SESSION_SUMMARY_MAX, type MemberDto, type SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { MembersApi } from '../../../core/members/members.api';
import { SessionsApi } from '../../../core/sessions/sessions.api';

export interface FinishSessionDialogData {
  sessionId: number;
  gameId: number;
  /** Дата й час сесії для заголовка (уже відформатовані). */
  when: string;
}

/**
 * «Завершити сесію»: присутність кожного активного учасника (типово — присутній) і
 * необов'язковий підсумок, який бачать лише майстер і учасники. Присутність надсилається для
 * всіх учасників. Закривається з оновленою `SessionDto`.
 */
@Component({
  selector: 'nri-finish-session-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './finish-session-dialog.html',
  styleUrl: './finish-session-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinishSessionDialog {
  protected readonly data = inject<FinishSessionDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<FinishSessionDialog, SessionDto>>(MatDialogRef);
  private readonly api = inject(SessionsApi);
  private readonly membersApi = inject(MembersApi);

  protected readonly max = SESSION_SUMMARY_MAX;
  protected readonly members = signal<MemberDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly form = new FormGroup({
    present: new FormArray<FormControl<boolean>>([]),
    summary: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(SESSION_SUMMARY_MAX)],
    }),
  });
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const list = await firstValueFrom(this.membersApi.list(this.data.gameId));
      const present = this.form.controls.present;
      present.clear();
      list.forEach(() => present.push(new FormControl(true, { nonNullable: true })));
      this.members.set(list);
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }

  protected async submit(): Promise<void> {
    const members = this.members();
    if (this.submitting() || !members) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    try {
      const dto = await firstValueFrom(
        this.api.finish(this.data.sessionId, {
          attendance: members.map((m, i) => ({ publicId: m.publicId, present: v.present[i]! })),
          summary: v.summary.trim() || null,
        }),
      );
      this.ref.close(dto);
    } catch (err) {
      const { code } = toApiError(err);
      if (code !== 'UNAUTHENTICATED') this.error.set(`errors.${code}`);
      // Склад міг змінитися (учасник вийшов) — оновлюємо список.
      if (code === 'VALIDATION') void this.load();
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }
}
