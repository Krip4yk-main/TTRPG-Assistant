import type { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import type { DialogConflict } from './dialog-conflict';
import { SanctionDialog, type SanctionDialogData } from './sanction-dialog/sanction-dialog';
import { TextDialog, type TextDialogData } from './text-dialog/text-dialog';

const CONFIG = {
  autoFocus: 'first-tabbable',
  restoreFocus: true,
  width: '560px',
  maxWidth: 'calc(100vw - 32px)',
} as const;

/**
 * Діалог дії з приміткою/причиною; результат — відповідь сервера, `DialogConflict` (409 —
 * об'єкт уже змінено) або `undefined` (скасовано).
 */
export function openTextDialog<R>(
  dialog: MatDialog,
  data: TextDialogData,
): Promise<R | DialogConflict | undefined> {
  return firstValueFrom(
    dialog
      .open<TextDialog, TextDialogData, R | DialogConflict>(TextDialog, { ...CONFIG, data })
      .afterClosed(),
  );
}

/** Діалог санкції; результат — як у `openTextDialog`. */
export function openSanctionDialog<R>(
  dialog: MatDialog,
  data: SanctionDialogData,
): Promise<R | DialogConflict | undefined> {
  return firstValueFrom(
    dialog
      .open<SanctionDialog, SanctionDialogData, R | DialogConflict>(SanctionDialog, {
        ...CONFIG,
        data,
      })
      .afterClosed(),
  );
}
