import type { MatDialog } from '@angular/material/dialog';
import type { SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import type { SessionAlternativesDialogData } from './session-alternatives-dialog';

/**
 * Відкрити «Інший час для сесії» — діалог вантажиться окремим чанком лише на вимогу.
 * Повертає перенесену сесію або `null`.
 */
export async function openSessionAlternatives(
  dialog: MatDialog,
  data: SessionAlternativesDialogData,
): Promise<SessionDto | null> {
  const { SessionAlternativesDialog } = await import('./session-alternatives-dialog');
  const ref = dialog.open(SessionAlternativesDialog, {
    data,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
    width: '600px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
