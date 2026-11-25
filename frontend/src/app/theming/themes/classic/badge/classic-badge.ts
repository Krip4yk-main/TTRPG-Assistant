import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm } from '../../../../core/games/game-card.vm';
import type { BadgeSlot } from '../../../slots';

/** Слот `badge` дизайну «Класичний»: обведена «пігулка» з кольором за видом і значенням. */
@Component({
  selector: 'nri-classic-badge',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './classic-badge.html',
  styleUrl: './classic-badge.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicBadge implements BadgeSlot {
  readonly badge = input.required<BadgeVm>();
}
