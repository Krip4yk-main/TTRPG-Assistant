import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { RestrictedGameDto, SearchGameCardDto } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { CatalogStore } from '../../../core/catalog/catalog.store';
import { toGameCardVm } from '../../../core/games/game-card.vm';
import { ViewModeStore } from '../../../core/view-mode/view-mode.store';
import { Slot } from '../../../theming/slot';

/**
 * Картка гри в пошуку й профілі: готує view-model (`toGameCardVm`) і віддає її слоту
 * `game-card` чинного дизайну.
 */
@Component({
  selector: 'nri-game-card',
  imports: [Slot],
  templateUrl: './game-card.html',
  styleUrl: './game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameCard {
  private readonly auth = inject(AuthStore);
  private readonly catalog = inject(CatalogStore);
  private readonly viewMode = inject(ViewModeStore);

  readonly game = input.required<SearchGameCardDto | RestrictedGameDto>();
  /** Гість бачить на обмеженій картці заклик увійти. */
  readonly guest = input(false);

  protected readonly vm = computed(() =>
    toGameCardVm(this.game(), this.auth.me(), {
      guest: this.guest(),
      genreKey: (id) => this.catalog.genreKey(id),
      viewMode: this.viewMode.mode(),
    }),
  );
}
