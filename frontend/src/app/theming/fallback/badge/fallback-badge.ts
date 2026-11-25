import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm } from '../../../core/games/game-card.vm';
import type { BadgeSlot } from '../../slots';

/** Резервний бейдж: текст у рамці. */
@Component({
  selector: 'nri-fallback-badge',
  imports: [TranslatePipe],
  templateUrl: './fallback-badge.html',
  styleUrl: './fallback-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackBadge implements BadgeSlot {
  readonly badge = input.required<BadgeVm>();
}
