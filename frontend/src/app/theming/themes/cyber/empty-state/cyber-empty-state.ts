import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { EmptyStateSlot, SlotLinkAction } from '../../../slots';

/**
 * Слот `empty-state` кібер-родини: темна скляна панель з неоновою трубкою вгорі —
 * повідомлення, підказка й дія.
 */
@Component({
  selector: 'nri-cy-empty-state',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './cyber-empty-state.html',
  styleUrl: './cyber-empty-state.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CyberEmptyState implements EmptyStateSlot {
  readonly messageKey = input.required<string>();
  readonly hintKey = input<string | null>(null);
  readonly action = input<SlotLinkAction | null>(null);
}
