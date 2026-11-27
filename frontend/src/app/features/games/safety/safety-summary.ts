import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { WarningChip } from '../../../shared/warning-chip/warning-chip';
import { type SafetyView, hasTopics } from './safety-view';

/**
 * Коротко про безпеку гри: інструменти (пояснення — розкривні, щоб не було стіни тексту),
 * межі й завіси чипами. Заголовок блоку задає батько; порожні частини не показуються.
 */
@Component({
  selector: 'nri-safety-summary',
  imports: [TranslatePipe, WarningChip],
  templateUrl: './safety-summary.html',
  styleUrl: './safety-summary.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SafetySummary {
  readonly safety = input.required<SafetyView>();

  protected readonly hasTopics = hasTopics;
}
