import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  MyGameActionEvent,
  MyGameActionVm,
  MyGameItemVm,
} from '../../../../core/games/my-game-item.vm';
import type { MyGameItemSlot } from '../../../slots';

/** Слот `my-game-item` дизайну «Класичний»: картка гри майстра з позначками й діями. */
@Component({
  selector: 'nri-classic-my-game-item',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './classic-my-game-item.html',
  styleUrl: './classic-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
