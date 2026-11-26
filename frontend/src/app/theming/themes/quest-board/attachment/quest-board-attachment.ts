import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { CoverAttachment } from '../../../shared/attachment/cover-attachment';

/**
 * Обкладинка гри на дошці — «вкладка» до оголошення: маленька картинка в рамці, підкладена
 * під аркуш у його верхньому правому куті (видно частину). Наведення мишею виносить її
 * наперед: вона виходить поверх аркуша, вирівнюється й збільшується; відведення повертає.
 * Поведінка (клік / Enter / Space, Esc, дотик деінде, зламана картинка) — спільна
 * `CoverAttachment`; картка пропускає кліки всередині `nri-qb-attachment` (гру не відкриває).
 *
 * Місце вкладки (top / right) задає оголошення, вигляд і рух — тут.
 */
@Component({
  selector: 'nri-qb-attachment',
  imports: [TranslatePipe],
  templateUrl: './quest-board-attachment.html',
  styleUrl: './quest-board-attachment.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: CoverAttachment, inputs: ['src', 'title'] }],
})
export class QuestBoardAttachment {
  protected readonly att = inject(CoverAttachment);
}
