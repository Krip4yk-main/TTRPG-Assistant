import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { PageHeaderSlot, SlotLinkAction } from '../../../slots';

/** Слот `page-header` дизайну «Класичний»: h1, підзаголовок і кнопки-посилання праворуч. */
@Component({
  selector: 'nri-classic-page-header',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './classic-page-header.html',
  styleUrl: './classic-page-header.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicPageHeader implements PageHeaderSlot {
  readonly titleKey = input.required<string>();
  readonly leadKey = input<string | null>(null);
  readonly actions = input<readonly SlotLinkAction[]>([]);
}
