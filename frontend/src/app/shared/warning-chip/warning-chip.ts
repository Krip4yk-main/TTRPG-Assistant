import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Чип попередження про контент. Для каталожного (`slug`) показує (i) з поясненням
 * (hover/фокус; `matTooltip` додає aria-describedby); власне попередження майстра (`custom`) — лише текст, без (i).
 */
@Component({
  selector: 'nri-warning-chip',
  imports: [MatIconModule, MatTooltipModule, TranslatePipe],
  templateUrl: './warning-chip.html',
  styleUrl: './warning-chip.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WarningChip {
  readonly slug = input<string | null>(null);
  readonly custom = input<string | null>(null);

  protected readonly hintKey = computed(() => {
    const s = this.slug();
    return s ? `warnings.${s}.hint` : null;
  });
  protected readonly labelKey = computed(() => {
    const s = this.slug();
    return s ? `warnings.${s}.label` : null;
  });
}
