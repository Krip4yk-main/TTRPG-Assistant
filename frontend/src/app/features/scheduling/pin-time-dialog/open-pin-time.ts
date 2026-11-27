import type { MatDialog } from '@angular/material/dialog';
import type { SessionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import type { PinTimeDialogData } from './pin-time-dialog';

/**
 * Відкрити «Уточнити час» сесії з приблизним часом — діалог вантажиться окремим чанком лише
 * на вимогу. Повертає сесію з точним часом або `null`.
 */
export async function openPinTime(
  dialog: MatDialog,
  data: PinTimeDialogData,
): Promise<SessionDto | null> {
  const { PinTimeDialog } = await import('./pin-time-dialog');
  const ref = dialog.open(PinTimeDialog, {
    data,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
    width: '600px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
