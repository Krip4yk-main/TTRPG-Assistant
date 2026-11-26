import type { MatDialog } from '@angular/material/dialog';
import type { GameDto, GameTransitionDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { PauseDialog, type PauseDialogData } from './pause-dialog';
import { ResumeDialog, type ResumeDialogData } from './resume-dialog';

/** Діалог «Поставити на паузу»; `null` — закрито без паузи. */
export async function openPauseDialog(
  dialog: MatDialog,
  data: PauseDialogData,
): Promise<GameDto | null> {
  const ref = dialog.open<PauseDialog, PauseDialogData, GameDto>(PauseDialog, {
    data,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
    width: '560px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}

/** Діалог «Відновити» / «Оголосити донабір»; `null` — закрито без змін. */
export async function openResumeDialog(
  dialog: MatDialog,
  data: ResumeDialogData,
): Promise<GameTransitionDto | null> {
  const ref = dialog.open<ResumeDialog, ResumeDialogData, GameTransitionDto>(ResumeDialog, {
    data,
    autoFocus: 'first-tabbable',
    restoreFocus: true,
    width: '560px',
    maxWidth: 'calc(100vw - 32px)',
  });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}

/** Ключ повідомлення після відновлення: донабір чи ні, і попередження про мінімум. */
export function resumedNoticeKey(dto: GameTransitionDto, recruit: boolean): string {
  if (dto.warning === 'BELOW_MIN_PLAYERS') return 'games.pause.done.resumedBelowMin';
  return recruit ? 'games.pause.done.recruit' : 'games.pause.done.resume';
}
