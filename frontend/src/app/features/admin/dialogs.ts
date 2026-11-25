import type { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { SanctionDialog, type SanctionDialogData } from './sanction-dialog/sanction-dialog';
import { TextDialog, type TextDialogData } from './text-dialog/text-dialog';

const CONFIG = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  width: '560px',
  maxWidth: 'calc(100vw - 32px)',
} as const;

/** Діалог дії з приміткою/причиною; результат — відповідь сервера або `undefined` (скасовано). */
export function openTextDialog<R>(dialog: MatDialog, data: TextDialogData): Promise<R | undefined> {
  return firstValueFrom(
    dialog.open<TextDialog, TextDialogData, R>(TextDialog, { ...CONFIG, data }).afterClosed(),
  );
}

/** Діалог санкції; результат — відповідь сервера або `undefined` (скасовано). */
export function openSanctionDialog<R>(
  dialog: MatDialog,
  data: SanctionDialogData,
): Promise<R | undefined> {
  return firstValueFrom(
    dialog
      .open<SanctionDialog, SanctionDialogData, R>(SanctionDialog, { ...CONFIG, data })
      .afterClosed(),
  );
}
