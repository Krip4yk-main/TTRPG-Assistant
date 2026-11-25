import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  MyGameActionEvent,
  MyGameActionVm,
  MyGameItemVm,
} from '../../../core/games/my-game-item.vm';
import type { MyGameItemSlot } from '../../slots';

/** Резервний рядок «Моїх ігор»: ті самі позначки й дії простими кнопками. */
@Component({
  selector: 'nri-fallback-my-game-item',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './fallback-my-game-item.html',
  styleUrl: './fallback-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
