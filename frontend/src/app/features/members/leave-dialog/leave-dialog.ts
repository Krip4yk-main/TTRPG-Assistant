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
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type AbstractControl,
  type ValidationErrors,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import { LEAVE_NOTE_MAX, LEAVE_NOTE_MIN } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { MembersApi } from '../../../core/members/members.api';

export interface LeaveDialogData {
  gameId: number;
  title: string;
}

/** Довжина без пробілів по краях (як рахує сервер після `trim`). */
function trimmedLength(min: number, max: number) {
  return (c: AbstractControl<string>): ValidationErrors | null => {
    const n = c.value.trim().length;
    if (n > max) return { tooLong: true };
    if (min > 0 && n < min) return { tooShort: true };
    return null;
  };
}

/**
 * «Вийти з гри»: пояснення для майстра (обов'язкове, ≥ 10 символів) і, за бажанням, для
 * адміністрації (порожнє — сервер скопіює текст для майстра). Запит іде з діалогу;
 * закривається з `true`, коли вихід відбувся.
 */
@Component({
  selector: 'nri-leave-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './leave-dialog.html',
  styleUrl: './leave-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeaveDialog {
  protected readonly data = inject<LeaveDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<LeaveDialog, boolean>>(MatDialogRef);
  private readonly api = inject(MembersApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly limits = { min: LEAVE_NOTE_MIN, max: LEAVE_NOTE_MAX };

  protected readonly form = new FormGroup({
    noteForGm: new FormControl('', {
      nonNullable: true,
      validators: [trimmedLength(LEAVE_NOTE_MIN, LEAVE_NOTE_MAX)],
    }),
    noteForAdmin: new FormControl('', {
      nonNullable: true,
      validators: [trimmedLength(0, LEAVE_NOTE_MAX)],
    }),
  });

  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Ключ помилки поля, якщо її вже варто показувати. */
  protected errorKey(control: AbstractControl): string | null {
    if (!control.invalid || !(control.touched || this.submitted())) return null;
    return control.hasError('tooLong') ? 'members.leave.tooLong' : 'members.leave.gmTooShort';
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.submitted.set(true);
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      afterNextRender(
        () =>
          this.host.nativeElement
            .querySelector<HTMLElement>('textarea[aria-invalid="true"]')
            ?.focus(),
        { injector: this.injector },
      );
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.api.leave(this.data.gameId, {
          noteForGm: v.noteForGm.trim(),
          noteForAdmin: v.noteForAdmin.trim() || null,
        }),
      );
      this.ref.close(true);
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
