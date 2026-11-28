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
    // Фокус на самому діалозі: вміст вантажиться, і першою фокусованою була б «Закрити» —
    // програмний фокус малював на ній тінт, і активна кнопка виглядала вимкненою. З клавіатури
    // Tab веде до першого елемента, як і раніше.
    autoFocus: 'dialog',
    restoreFocus: true,
    width: '600px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
