import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { formatRating } from '../../../core/ratings/rating-format';

/**
 * Компактний загальний рейтинг майстра (картка й сторінка гри): «★ 4,6». Без рейтингу —
 * нічого або, з `showEmpty`, «ще немає рейтингу».
 */
@Component({
  selector: 'nri-gm-rating',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './gm-rating.html',
  styleUrl: './gm-rating.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GmRating {
  readonly value = input.required<number | null>();
  readonly showEmpty = input(false);

  protected readonly text = computed(() => {
    const v = this.value();
    return v === null ? null : formatRating(v);
  });
}
