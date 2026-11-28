import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';

/** Підтвердження видалення акаунта; закривається з `true`, якщо користувач погодився. */
@Component({
  selector: 'nri-delete-account-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  templateUrl: './delete-account-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteAccountDialog {}
