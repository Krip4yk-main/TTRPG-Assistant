import type { MatDialog } from '@angular/material/dialog';
import type { GameStatus } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/**
 * Підтвердження «Закрити» для гри з позначкою «давно не проводилась» / «мертва»: що станеться
 * з грою, залежить від статусу (набір → скасована, почата → завершена).
 */
export async function confirmCloseDead(
  dialog: MatDialog,
  game: { title: string; status: GameStatus },
): Promise<boolean> {
  const data: ConfirmDialogData = {
    title: 'games.dead.closeConfirm.title',
    text: 'games.dead.closeConfirm.text',
    params: { title: game.title },
    note:
      game.status === 'started'
        ? 'games.dead.closeConfirm.started'
        : 'games.dead.closeConfirm.recruiting',
    confirm: 'games.dead.closeConfirm.confirm',
    danger: true,
  };
  const ref = dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
    data,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
  });
  return (await firstValueFrom(ref.afterClosed())) === true;
}
