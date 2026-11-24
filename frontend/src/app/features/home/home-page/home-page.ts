import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthStore } from '../../../core/auth/auth.store';
import { ViewModeStore } from '../../../core/view-mode/view-mode.store';
import { MyGames } from '../../games/my-games/my-games';
import { Home } from '../home';

/** Головна за видом: майстер (активний) бачить «Мої ігри», гравець — пошук (поки заглушка). */
@Component({
  selector: 'nri-home-page',
  imports: [Home, MyGames],
  templateUrl: './home-page.html',
  styleUrl: './home-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePage {
  private readonly auth = inject(AuthStore);
  private readonly viewMode = inject(ViewModeStore);

  protected readonly gmHome = computed(() => this.viewMode.mode() === 'gm' && this.auth.isActive());
}
