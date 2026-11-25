import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm } from '../../../../core/games/game-card.vm';
import type { BadgeSlot } from '../../../slots';

/**
 * Слот `badge` дизайну «Дошка оголошень»: штамп чорнилом на папері. Збіг з розкладом —
 * стрічка з моху, вік — сургучний штамп, статус — штамп чорнилом.
 */
@Component({
  selector: 'nri-qb-badge',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './quest-board-badge.html',
  styleUrl: './quest-board-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardBadge implements BadgeSlot {
  readonly badge = input.required<BadgeVm>();
}
