import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm } from '../../../../core/games/game-card.vm';
import type { BadgeSlot } from '../../../slots';

/**
 * Слот `badge` кібер-родини: моноширинна мітка. Збіг з розкладом — «пігулка» зі світним
 * діодом (повний — лайм, частковий — бурштин), вік — червона рамка, статус — рамка кольору
 * тексту (скасована — червона, завершена — приглушена).
 */
@Component({
  selector: 'nri-cy-badge',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './cyber-badge.html',
  styleUrl: './cyber-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CyberBadge implements BadgeSlot {
  readonly badge = input.required<BadgeVm>();
}
