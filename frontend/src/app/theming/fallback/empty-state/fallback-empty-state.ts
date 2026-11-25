import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { EmptyStateSlot, SlotLinkAction } from '../../slots';

/** Резервний порожній стан. */
@Component({
  selector: 'nri-fallback-empty-state',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './fallback-empty-state.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackEmptyState implements EmptyStateSlot {
  readonly messageKey = input.required<string>();
  readonly hintKey = input<string | null>(null);
  readonly action = input<SlotLinkAction | null>(null);
}
