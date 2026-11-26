import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

/** Дія майстра з паузи. */
export type PauseAction = 'resume' | 'recruit' | 'finish' | 'cancel';

/** Що показати на панелі паузи (усе вже відформатовано). */
export interface PauseInfo {
  /** З якого моменту — у поясі глядача, без назви поясу; `null` — невідомо. */
  since: string | null;
  /** Ключ причини (`games.pause.reasons.*`); `null` — не видно (сторонній глядач). */
  reasonKey: string | null;
  /** Пояснення майстра (бачать майстер і учасники). */
  note: string | null;
}

/**
 * Панель «Кампейн на паузі» на сторінці гри: з якого часу, причина й пояснення; майстру —
 * «Відновити», «Оголосити донабір» і «Завершити кампейн», учаснику — підказка.
 */
@Component({
  selector: 'nri-pause-panel',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './pause-panel.html',
  styleUrl: './pause-panel.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'region', 'aria-labelledby': 'pause-panel-title' },
})
export class PausePanel {
  readonly info = input.required<PauseInfo>();
  readonly isGm = input(false);
  readonly member = input(false);
  readonly busy = input(false);
  readonly action = output<PauseAction>();
}
