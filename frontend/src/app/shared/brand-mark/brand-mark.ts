import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Знак «НРІ Асистент» — каркас d20 лінією. Один знак для всіх дизайнів: колір — `currentColor`
 * (дизайн задає його на хості чи батьку), розмір — вхід `size` у пікселях.
 */
@Component({
  selector: 'nri-brand-mark',
  templateUrl: './brand-mark.html',
  styleUrl: './brand-mark.less',
  host: { '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMark {
  readonly size = input(30);
}
