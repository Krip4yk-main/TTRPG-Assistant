import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { EmptyStateSlot, SlotLinkAction } from '../../../slots';

/** Слот `empty-state` дизайну «Класичний»: картка з повідомленням, підказкою й дією. */
@Component({
  selector: 'nri-classic-empty-state',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './classic-empty-state.html',
  styleUrl: './classic-empty-state.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicEmptyState implements EmptyStateSlot {
  readonly messageKey = input.required<string>();
  readonly hintKey = input<string | null>(null);
  readonly action = input<SlotLinkAction | null>(null);
}
