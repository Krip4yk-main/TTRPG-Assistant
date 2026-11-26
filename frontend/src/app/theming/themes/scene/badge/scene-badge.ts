import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm } from '../../../../core/games/game-card.vm';
import type { BadgeSlot } from '../../../slots';

/**
 * Слот `badge` родини сцени: моноширинна мітка. Збіг з розкладом — «пігулка» зі світним
 * діодом (повний — лайм, частковий — бурштин), вік — червона рамка, статус — рамка кольору
 * тексту (скасована — червона, завершена — приглушена).
 */
@Component({
  selector: 'nri-sc-badge',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './scene-badge.html',
  styleUrl: './scene-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SceneBadge implements BadgeSlot {
  readonly badge = input.required<BadgeVm>();
}
