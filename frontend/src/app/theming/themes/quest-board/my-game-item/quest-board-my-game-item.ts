import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  MyGameActionEvent,
  MyGameActionVm,
  MyGameItemVm,
} from '../../../../core/games/my-game-item.vm';
import type { MyGameItemSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';

/**
 * Слот `my-game-item` дизайну «Дошка оголошень»: оголошення майстра без повороту — статус
 * штампом, позначки «давно не проводилась / мертва / підозріла» приписками, дії внизу.
 */
@Component({
  selector: 'nri-qb-my-game-item',
  imports: [RouterLink, MatButtonModule, TranslatePipe, TruncateTooltip],
  templateUrl: './quest-board-my-game-item.html',
  styleUrl: './quest-board-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
