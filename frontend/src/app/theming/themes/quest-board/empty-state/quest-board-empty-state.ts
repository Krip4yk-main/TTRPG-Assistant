import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { EmptyStateSlot, SlotLinkAction } from '../../../slots';

/**
 * Слот `empty-state` дизайну «Дошка оголошень»: приколотий папірець з повідомленням,
 * підказкою й дією.
 */
@Component({
  selector: 'nri-qb-empty-state',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './quest-board-empty-state.html',
  styleUrl: './quest-board-empty-state.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardEmptyState implements EmptyStateSlot {
  readonly messageKey = input.required<string>();
  readonly hintKey = input<string | null>(null);
  readonly action = input<SlotLinkAction | null>(null);
}
