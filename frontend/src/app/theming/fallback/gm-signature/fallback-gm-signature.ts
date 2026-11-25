import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GmSignatureVm } from '../../../core/games/game-card.vm';
import { BlockedBadge } from '../../../shared/blocked-badge/blocked-badge';
import { GmRating } from '../../../features/ratings/gm-rating/gm-rating';
import type { GmSignatureSlot } from '../../slots';

/** Резервний підпис майстра. */
@Component({
  selector: 'nri-fallback-gm-signature',
  imports: [RouterLink, TranslatePipe, BlockedBadge, GmRating],
  templateUrl: './fallback-gm-signature.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackGmSignature implements GmSignatureSlot {
  readonly gm = input.required<GmSignatureVm>();
}
