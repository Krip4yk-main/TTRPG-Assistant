import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GmSignatureVm } from '../../../../core/games/game-card.vm';
import { BlockedBadge } from '../../../../shared/blocked-badge/blocked-badge';
import { GmRating } from '../../../../features/ratings/gm-rating/gm-rating';
import type { GmSignatureSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';

/** Слот `gm-signature` дизайну «Класичний»: «Майстер: нік», «заблоковано», рейтинг. */
@Component({
  selector: 'nri-classic-gm-signature',
  imports: [RouterLink, TranslatePipe, BlockedBadge, GmRating, TruncateTooltip],
  templateUrl: './classic-gm-signature.html',
  styleUrl: './classic-gm-signature.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicGmSignature implements GmSignatureSlot {
  readonly gm = input.required<GmSignatureVm>();
}
