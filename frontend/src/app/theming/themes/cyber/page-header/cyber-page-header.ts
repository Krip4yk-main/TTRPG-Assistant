import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { PageHeaderSlot, SlotLinkAction } from '../../../slots';

/**
 * Слот `page-header` кібер-родини: заголовок-вивіска (пластина з неоновими літерами — у
 * бандлі дизайну, `.cy-sign`), підзаголовок під нею і кнопки праворуч.
 */
@Component({
  selector: 'nri-cy-page-header',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './cyber-page-header.html',
  styleUrl: './cyber-page-header.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CyberPageHeader implements PageHeaderSlot {
  readonly titleKey = input.required<string>();
  readonly leadKey = input<string | null>(null);
  readonly actions = input<readonly SlotLinkAction[]>([]);
}
