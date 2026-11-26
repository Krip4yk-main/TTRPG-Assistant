import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type {
  MyGameActionEvent,
  MyGameActionVm,
  MyGameItemVm,
} from '../../../../core/games/my-game-item.vm';
import type { MyGameItemSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { LinePipe } from '../../../../core/i18n/line.pipe';
import { neonOf } from '../neon';
import { SceneAttachment } from '../attachment/scene-attachment';

/**
 * Слот `my-game-item` родини сцени: панель на стіні з лінією-акцентом кольору варіанта гри
 * (`data-neon`, той самий, що в картці пошуку; ті самі гачки декору `sc-d*` / `sc-p*`) — статус, позначки «давно не
 * проводилась / мертва / підозріла», дати й місця, заявки, дії внизу. Обкладинка — знімок за
 * кутом панелі (`nri-sc-attachment`, та сама поведінка, що в картці пошуку).
 */
@Component({
  selector: 'nri-sc-my-game-item',
  imports: [RouterLink, MatButtonModule, TranslatePipe, TruncateTooltip, LinePipe, SceneAttachment],
  templateUrl: './scene-my-game-item.html',
  styleUrl: './scene-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-neon]': 'neon()' },
})
export class SceneMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();
  /** Колір неону за id гри (спільне правило з карткою пошуку). */
  protected readonly neon = computed(() => neonOf(this.item().id));

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
