import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import type { PagedView } from '../paged';

/** Стан списку адмінки під ним: завантаження, помилка з повтором, «порожньо», «Завантажити ще». */
@Component({
  selector: 'nri-admin-pager',
  imports: [MatButtonModule, TranslatePipe],
  templateUrl: './pager.html',
  styleUrl: './pager.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPager {
  readonly list = input.required<PagedView>();
  /** Ключ i18n для порожнього списку. */
  readonly emptyKey = input('admin.empty');

  protected retry(): void {
    const l = this.list();
    void (l.loaded() ? l.more() : l.reload());
  }
}
