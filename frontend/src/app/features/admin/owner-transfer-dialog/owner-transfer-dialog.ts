import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminUserDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AdminApi } from '../../../core/moderation/admin.api';

/** Кому передати права власника (чинний адміністратор). */
export interface OwnerTransferDialogData {
  publicId: string;
  nickname: string;
}

/** Нік, як його порівнює бекенд: без пробілів по краях, без регістру. */
const norm = (s: string) => s.trim().toLocaleLowerCase('uk');

/**
 * Передача прав власника: незворотна для поточного власника (стає адміністратором), тож
 * кнопка активна лише після введення ніку того, кому передаються права. 400
 * `OWNER_TRANSFER_INVALID` пояснюється за `details.reason`. Закривається з карткою нового
 * власника.
 */
@Component({
  selector: 'nri-owner-transfer-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  templateUrl: './owner-transfer-dialog.html',
  styleUrl: './owner-transfer-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OwnerTransferDialog {
  protected readonly data = inject<OwnerTransferDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<OwnerTransferDialog, AdminUserDto>>(MatDialogRef);
  private readonly api = inject(AdminApi);

  protected readonly nickname = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({ nickname: this.nickname });
  private readonly value = toSignal(this.nickname.valueChanges, { initialValue: '' });
  /** Введений нік збігається з ніком адресата. */
  protected readonly matches = computed(() => norm(this.value()) === norm(this.data.nickname));

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting() || !this.matches()) return;
    this.error.set(null);
    this.submitting.set(true);
    try {
      const card = await firstValueFrom(
        this.api.transferOwner({
          toPublicId: this.data.publicId,
          confirmNickname: this.nickname.value.trim(),
        }),
      );
      this.ref.close(card);
    } catch (err) {
      const { code, details } = toApiError(err);
      const reason = (details as { reason?: unknown } | undefined)?.reason;
      if (
        code === 'OWNER_TRANSFER_INVALID' &&
        (reason === 'NOT_ADMIN' || reason === 'NICKNAME_MISMATCH')
      ) {
        this.error.set(`admin.transfer.errors.${reason}`);
      } else if (code !== 'UNAUTHENTICATED') {
        this.error.set(`errors.${code}`);
      }
      this.submitting.set(false);
    }
  }

  protected cancel(): void {
    this.ref.close();
  }
}
