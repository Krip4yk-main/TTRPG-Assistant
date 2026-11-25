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
import { MatSelectModule } from '@angular/material/select';
import { TranslatePipe } from '@ngx-translate/core';
import {
  MODERATION_TEXT_MAX,
  SANCTION_DURATIONS,
  SANCTION_TYPES,
  type SanctionDuration,
  type SanctionInput,
  type SanctionType,
  type UserRole,
} from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { roleAtLeast } from '../../../core/auth/roles';

export interface SanctionDialogData {
  /** Кого карають (нік) — для заголовка. */
  name: string;
  /** Роль того, хто накладає: глобальний бан — лише адміну й власнику. */
  actorRole: UserRole;
  /** Скарга на гру — санкцію отримає її майстер (пояснення в діалозі). */
  gmOfGame?: string;
  /** Обмежити вибір типів (напр. видаленому акаунту — лише бан). */
  types?: readonly SanctionType[];
  /** Запит; помилки показуються в діалозі. */
  submit: (input: SanctionInput) => Observable<unknown>;
}

function trimmedRequired(control: AbstractControl<string>): ValidationErrors | null {
  return control.value.trim() ? null : { required: true };
}

/**
 * Діалог санкції: тип (глобальний бан — лише адміну/власнику), строк і причина (її бачить
 * покараний). Закривається з відповіддю сервера.
 */
@Component({
  selector: 'nri-sanction-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    TranslatePipe,
  ],
  templateUrl: './sanction-dialog.html',
  styleUrl: './sanction-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SanctionDialog {
  protected readonly data = inject<SanctionDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SanctionDialog, unknown>>(MatDialogRef);

  protected readonly max = MODERATION_TEXT_MAX;
  protected readonly durations = SANCTION_DURATIONS;
  protected readonly types = (this.data.types ?? SANCTION_TYPES).filter(
    (t) => t !== 'global_ban' || roleAtLeast(this.data.actorRole, 'admin'),
  );

  protected readonly form = new FormGroup({
    type: new FormControl<SanctionType | null>(this.types.length === 1 ? this.types[0]! : null, {
      validators: [Validators.required],
    }),
    duration: new FormControl<SanctionDuration>('7d', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    reason: new FormControl('', {
      nonNullable: true,
      validators: [trimmedRequired, Validators.maxLength(MODERATION_TEXT_MAX)],
    }),
  });
  private readonly reasonValue = toSignal(this.form.controls.reason.valueChanges, {
    initialValue: '',
  });
  protected readonly length = computed(() => this.reasonValue().length);
  private readonly typeValue = toSignal(this.form.controls.type.valueChanges, {
    initialValue: this.form.controls.type.value,
  });
  protected readonly isBan = computed(() => this.typeValue() === 'global_ban');

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    try {
      const result = await firstValueFrom(
        this.data.submit({ type: v.type!, duration: v.duration, reason: v.reason.trim() }),
      );
      this.ref.close(result);
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
