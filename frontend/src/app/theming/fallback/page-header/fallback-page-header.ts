import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type { PageHeaderSlot, SlotLinkAction } from '../../slots';

/** Резервний заголовок сторінки. */
@Component({
  selector: 'nri-fallback-page-header',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './fallback-page-header.html',
  styleUrl: './fallback-page-header.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackPageHeader implements PageHeaderSlot {
  readonly titleKey = input.required<string>();
  readonly leadKey = input<string | null>(null);
  readonly actions = input<readonly SlotLinkAction[]>([]);
}
