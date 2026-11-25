import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { PageHeaderSlot, SlotLinkAction } from '../../../slots';

/**
 * Слот `page-header` дизайну «Дошка оголошень»: великий заголовок Kurale (на дереві — з
 * тінню), підзаголовок і кнопки праворуч.
 */
@Component({
  selector: 'nri-qb-page-header',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './quest-board-page-header.html',
  styleUrl: './quest-board-page-header.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardPageHeader implements PageHeaderSlot {
  readonly titleKey = input.required<string>();
  readonly leadKey = input<string | null>(null);
  readonly actions = input<readonly SlotLinkAction[]>([]);
}
