import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

/** Ключі i18n діалогу підтвердження. */
export interface ConfirmDialogData {
  title: string;
  text: string;
  confirm: string;
  /** Параметри для `text` (інтерполяція ngx-translate). */
  params?: Record<string, unknown>;
  /** Небезпечна дія — кнопка підтвердження червона. */
  danger?: boolean;
}

/** Підтвердження дії; закривається з `true`, якщо користувач погодився. Фокус — на «Скасувати». */
@Component({
  selector: 'nri-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
