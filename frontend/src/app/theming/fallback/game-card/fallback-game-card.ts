import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameCardVm } from '../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../slots';
import { FallbackBadge } from '../badge/fallback-badge';
import { FallbackGmSignature } from '../gm-signature/fallback-gm-signature';

/**
 * Резервна картка гри: ті самі дані, що в дизайнах, без обкладинки й декору. Гру відкриває
 * посилання-назва (`routerLink`).
 */
@Component({
  selector: 'nri-fallback-game-card',
  imports: [RouterLink, TranslatePipe, FallbackBadge, FallbackGmSignature],
  templateUrl: './fallback-game-card.html',
  styleUrl: './fallback-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();
}
