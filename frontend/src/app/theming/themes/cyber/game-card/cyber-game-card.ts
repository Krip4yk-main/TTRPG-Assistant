import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { CyberBadge } from '../badge/cyber-badge';
import { CyberGmSignature } from '../gm-signature/cyber-gm-signature';

/**
 * Слот `game-card` кібер-родини — тимчасова проста темна картка (до власної картки
 * кібер-дизайнів з обкладинкою за панеллю). Обмежена картка — лише назва, майстер і вікова
 * позначка під блюром (решту полів view-model для неї не містить).
 */
@Component({
  selector: 'nri-cy-game-card',
  imports: [
    RouterLink,
    MatIconModule,
    TranslatePipe,
    CyberBadge,
    CyberGmSignature,
    TruncateTooltip,
  ],
  templateUrl: './cyber-game-card.html',
  styleUrl: './cyber-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CyberGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();
}
