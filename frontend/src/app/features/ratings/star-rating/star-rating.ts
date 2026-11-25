import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  model,
  viewChildren,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { RATING_SCORE_MAX, RATING_SCORE_MIN } from '@nri/shared';

const SCALE = Array.from(
  { length: RATING_SCORE_MAX - RATING_SCORE_MIN + 1 },
  (_, i) => RATING_SCORE_MIN + i,
);

/**
 * Оцінка зірками 1–5 як доступна radiogroup: кожна зірка — `role="radio"` з `aria-checked`
 * і підписом «4 з 5»; фокус лише на вибраній (або першій), ←/→/↑/↓ — сусідня з вибором,
 * Home/End — крайні. Поруч видно вибране значення текстом.
 */
@Component({
  selector: 'nri-star-rating',
  imports: [MatIconModule, TranslatePipe],
  templateUrl: './star-rating.html',
  styleUrl: './star-rating.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StarRating {
  readonly value = model<number | null>(null);
  /** `id` видимого підпису групи. */
  readonly labelledBy = input.required<string>();
  readonly describedBy = input<string | null>(null);
  readonly required = input(false);
  readonly invalid = input(false);
  readonly disabled = input(false);

  protected readonly scale = SCALE;
  protected readonly max = RATING_SCORE_MAX;
  /** Зірка, що в порядку Tab: вибрана, інакше перша. */
  protected readonly tabStop = computed(() => this.value() ?? RATING_SCORE_MIN);
  private readonly stars = viewChildren<ElementRef<HTMLButtonElement>>('star');

  protected select(n: number): void {
    if (this.disabled()) return;
    this.value.set(n);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const current = this.value();
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = current === null || current >= RATING_SCORE_MAX ? RATING_SCORE_MIN : current + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = current === null || current <= RATING_SCORE_MIN ? RATING_SCORE_MAX : current - 1;
        break;
      case 'Home':
        next = RATING_SCORE_MIN;
        break;
      case 'End':
        next = RATING_SCORE_MAX;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.value.set(next);
    this.stars()[next - RATING_SCORE_MIN]?.nativeElement.focus();
  }
}
