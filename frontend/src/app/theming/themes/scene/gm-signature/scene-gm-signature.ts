import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { GmSignatureVm } from '../../../../core/games/game-card.vm';
import { BlockedBadge } from '../../../../shared/blocked-badge/blocked-badge';
import { GmRating } from '../../../../features/ratings/gm-rating/gm-rating';
import type { GmSignatureSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { formatRating } from '../../../../core/ratings/rating-format';

/**
 * Слот `gm-signature` родини сцени: темний кружок з першою літерою ніку в неоновому обідку
 * (колір картки, `--sc-n`), нік-посилання, під ним «майстер · ★ рейтинг» (або «ще немає
 * рейтингу»), «заблоковано».
 */
@Component({
  selector: 'nri-sc-gm-signature',
  imports: [RouterLink, TranslatePipe, BlockedBadge, GmRating, TruncateTooltip],
  templateUrl: './scene-gm-signature.html',
  styleUrl: './scene-gm-signature.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SceneGmSignature implements GmSignatureSlot {
  readonly gm = input.required<GmSignatureVm>();

  /** Літера в кружку (декор): перша літера ніку; видалений акаунт — «?». */
  protected readonly initial = computed(() => {
    const nick = this.gm().nickname?.trim();
    return nick ? Array.from(nick)[0]!.toUpperCase() : '?';
  });

  /**
   * Підказка рядка ролі — видимий текст повністю (один ключ uk.json з параметрами):
   * «майстер · ★ 4,5», «майстер · ще немає рейтингу» або просто «майстер».
   */
  protected readonly roleTip = computed((): { key: string; params?: Record<string, string> } => {
    const g = this.gm();
    if (!g.showRating) return { key: 'scene.gmRole.plain' };
    if (g.rating === null) return { key: 'scene.gmRole.none' };
    return { key: 'scene.gmRole.rated', params: { rating: formatRating(g.rating) } };
  });
}
