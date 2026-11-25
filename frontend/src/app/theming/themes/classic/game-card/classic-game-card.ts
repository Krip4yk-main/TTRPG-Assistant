import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { ClassicBadge } from '../badge/classic-badge';
import { ClassicGmSignature } from '../gm-signature/classic-gm-signature';

/**
 * Слот `game-card` дизайну «Класичний». Обмежена картка — лише назва, майстер і вікова
 * позначка під блюром (решту полів view-model для неї не містить).
 */
@Component({
  selector: 'nri-classic-game-card',
  imports: [RouterLink, MatIconModule, TranslatePipe, ClassicBadge, ClassicGmSignature],
  templateUrl: './classic-game-card.html',
  styleUrl: './classic-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();
}
