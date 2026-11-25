import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GmSignatureVm } from '../../../../core/games/game-card.vm';
import { BlockedBadge } from '../../../../shared/blocked-badge/blocked-badge';
import { GmRating } from '../../../../features/ratings/gm-rating/gm-rating';
import type { GmSignatureSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';

/**
 * Слот `gm-signature` дизайну «Дошка оголошень»: кружок з першою літерою ніку, нік-посилання,
 * під ним «майстер» і рейтинг (або «ще немає рейтингу»), «заблоковано».
 */
@Component({
  selector: 'nri-qb-gm-signature',
  imports: [RouterLink, TranslatePipe, BlockedBadge, GmRating, TruncateTooltip],
  templateUrl: './quest-board-gm-signature.html',
  styleUrl: './quest-board-gm-signature.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardGmSignature implements GmSignatureSlot {
  readonly gm = input.required<GmSignatureVm>();

  /** Літера в кружку (декор): перша літера ніку; видалений акаунт — «?». */
  protected readonly initial = computed(() => {
    const nick = this.gm().nickname?.trim();
    return nick ? Array.from(nick)[0]!.toUpperCase() : '?';
  });
}
