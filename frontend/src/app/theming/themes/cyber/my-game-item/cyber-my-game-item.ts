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

/**
 * Слот `my-game-item` кібер-родини: темна скляна панель з неоновою трубкою кольору гри
 * (`data-neon`, той самий колір, що в картці пошуку) — статус, позначки «давно не
 * проводилась / мертва / підозріла», дати й місця, заявки, дії внизу.
 */
@Component({
  selector: 'nri-cy-my-game-item',
  imports: [RouterLink, MatButtonModule, TranslatePipe, TruncateTooltip, LinePipe],
  templateUrl: './cyber-my-game-item.html',
  styleUrl: './cyber-my-game-item.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-neon]': 'neon()' },
})
export class CyberMyGameItem implements MyGameItemSlot {
  readonly item = input.required<MyGameItemVm>();
  readonly busy = input(false);
  readonly action = output<MyGameActionEvent>();
  /** Колір неону за id гри (спільне правило з карткою пошуку). */
  protected readonly neon = computed(() => neonOf(this.item().id));

  protected emit(a: MyGameActionVm): void {
    if (a.id !== 'edit') this.action.emit({ action: a.id });
  }
}
