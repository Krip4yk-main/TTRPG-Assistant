import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
  GM_CRITERIA,
  PLAYER_CRITERIA,
  type PublishedRatingDto,
  type RatingCriterion,
} from '@nri/shared';
import { formatRating, unitsKey } from '../../../core/ratings/rating-format';

interface CriterionRow {
  key: RatingCriterion;
  value: string;
}

/**
 * Опублікований рейтинг: «4,6 · 12 оцінок» і критерії з назвами (лише ті, що вже
 * опубліковані). `null` — «Ще немає рейтингу (потрібно 5 оцінок)».
 */
@Component({
  selector: 'nri-rating-summary',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './rating-summary.html',
  styleUrl: './rating-summary.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RatingSummary {
  readonly rating = input.required<PublishedRatingDto | null>();
  /** Чий рейтинг: набір і порядок критеріїв. */
  readonly kind = input.required<'gm' | 'player'>();

  protected readonly overall = computed(() => {
    const r = this.rating();
    return r ? formatRating(r.overall) : null;
  });
  protected readonly unitsKey = computed(() => unitsKey(this.rating()?.units ?? 0));
  protected readonly criteria = computed<CriterionRow[]>(() => {
    const r = this.rating();
    if (!r) return [];
    const order: readonly RatingCriterion[] = this.kind() === 'gm' ? GM_CRITERIA : PLAYER_CRITERIA;
    return order.flatMap((key) => {
      const v = r.criteria[key];
      return v === undefined ? [] : [{ key, value: formatRating(v) }];
    });
  });
}
