import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { RANK_APPEARANCE } from '../../../../shared/action-rank';
import type {
  MyGameActionEvent,
  MyGameActionVm,
  MyGameItemVm,
} from '../../../../core/games/my-game-item.vm';
import type { MyGameItemSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { LinePipe } from '../../../../core/i18n/line.pipe';
import { QuestBoardAttachment } from '../attachment/quest-board-attachment';
import { paperVariant } from '../paper';

/**
 * Слот `my-game-item` дизайну «Дошка оголошень»: оголошення майстра без повороту — статус
 * штампом, позначки «давно не проводилась / мертва / підозріла» приписками, дії внизу.
 * Обкладинка — вкладка під аркушем (виходить наперед при наведенні / фокусі).
 */
@Component({
  selector: 'nri-qb-my-game-item',
  imports: [
    RouterLink,
    MatButtonModule,
    TranslatePipe,
    TruncateTooltip,
    LinePipe,
    QuestBoardAttachment,
  ],
  templateUrl: './quest-board-my-game-item.html',
  styleUrl: './quest-board-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();
  /** Вигляд кнопки за рангом дії (залита / обведена / текстова). */
  protected readonly appearance = RANK_APPEARANCE;
  /** Обрис пергаменту за id гри (спільне правило з оголошенням пошуку). */
  protected readonly paper = computed(() => paperVariant(this.item().id));

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
