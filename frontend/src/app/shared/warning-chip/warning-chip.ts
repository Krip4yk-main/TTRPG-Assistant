import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { TapTooltip } from '../tap-tooltip/tap-tooltip';

/**
 * Чип попередження про контент. Для каталожного (`slug`) показує (i) з поясненням
 * (hover/фокус; на дотикових екранах — по натисканню, `nriTapTooltip`; `matTooltip` додає
 * aria-describedby); власне попередження майстра (`custom`) — лише текст, без (i).
 * `selectable` — мітка стає кнопкою-перемикачем (`aria-pressed`) для мультивибору у формі;
 * (i) лишається окремою кнопкою поруч (не вкладеною).
 */
@Component({
  selector: 'nri-warning-chip',
  imports: [MatIconModule, MatTooltipModule, TapTooltip, TranslatePipe],
  templateUrl: './warning-chip.html',
  styleUrl: './warning-chip.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WarningChip {
  readonly slug = input<string | null>(null);
  readonly custom = input<string | null>(null);
  readonly selectable = input(false);
  readonly selected = input(false);
  readonly toggled = output<void>();

  protected readonly hintKey = computed(() => {
    const s = this.slug();
    return s ? `warnings.${s}.hint` : null;
  });
  protected readonly labelKey = computed(() => {
    const s = this.slug();
    return s ? `warnings.${s}.label` : null;
  });
}
