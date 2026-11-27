import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GameCardVm } from '../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../slots';
import { FallbackBadge } from '../badge/fallback-badge';
import { FallbackGmSignature } from '../gm-signature/fallback-gm-signature';
import { GameOpenedMoment } from '../../moments/game-opened';

/**
 * Резервна картка гри: ті самі дані, що в дизайнах, без обкладинки й декору. Гру відкриває
 * посилання-назва (`routerLink`); звичайний клік по ньому — перехід з картки (`gameOpened`).
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
  private readonly gameOpened = inject(GameOpenedMoment);

  /** Клік, з яким `routerLink` переходить сам (не нова вкладка й не середня кнопка). */
  protected onTitleClick(event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    this.gameOpened.fromCard(this.game().id);
  }
}
