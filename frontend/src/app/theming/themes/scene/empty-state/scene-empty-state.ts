import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { EmptyStateSlot, SlotLinkAction } from '../../../slots';

/**
 * Слот `empty-state` родини сцени: темна скляна панель з неоновою трубкою вгорі —
 * повідомлення, підказка й дія.
 */
@Component({
  selector: 'nri-sc-empty-state',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './scene-empty-state.html',
  styleUrl: './scene-empty-state.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SceneEmptyState implements EmptyStateSlot {
  readonly messageKey = input.required<string>();
  readonly hintKey = input<string | null>(null);
  readonly action = input<SlotLinkAction | null>(null);
}
