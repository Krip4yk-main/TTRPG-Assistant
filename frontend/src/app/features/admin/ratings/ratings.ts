import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import type { AdminRatingDto, AdminRatingFilter, RatingCriterion } from '@nri/shared';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { openTextDialog } from '../dialogs';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

/**
 * Черга «Відгуки»: ще не модеровані оцінки (фільтр «нові» / «з текстом»), обидві сторони,
 * гра, бали й текст. «Сховати текст» і «Анулювати оцінку» — лише з причиною в діалозі
 * підтвердження; після дії оцінка зникає з черги. Автора не сповіщають.
 */
@Component({
  selector: 'nri-admin-ratings',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    TranslatePipe,
    AdminDatePipe,
    AdminPager,
    AdminUserRef,
  ],
  templateUrl: './ratings.html',
  styleUrls: ['../admin-list.less', './ratings.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRatings {
  private readonly api = inject(AdminApi);
  private readonly dialog = inject(MatDialog);

  protected readonly filters: readonly AdminRatingFilter[] = ['new', 'commented'];
  protected readonly filter = signal<AdminRatingFilter>('new');
  protected readonly list = new Paged<AdminRatingDto>((cursor) =>
    this.api.ratings(this.filter(), cursor),
  );

  constructor() {
    void this.list.reload();
  }

  protected setFilter(f: AdminRatingFilter): void {
    if (f === this.filter()) return;
    this.filter.set(f);
    void this.list.reload();
  }

  protected criteria(r: AdminRatingDto): { key: RatingCriterion; value: number }[] {
    return (Object.entries(r.criteria) as [RatingCriterion, number][]).map(([key, value]) => ({
      key,
      value,
    }));
  }

  protected async hideText(r: AdminRatingDto): Promise<void> {
    const saved = await openTextDialog<AdminRatingDto>(this.dialog, {
      title: 'admin.ratings.hideTitle',
      text: 'admin.ratings.hideText',
      label: 'admin.reason',
      required: true,
      confirm: 'admin.ratings.hide',
      danger: true,
      submit: (reason) => this.api.hideRatingText(r.id, reason ?? ''),
    });
    if (saved) this.list.remove(r);
  }

  protected async cancel(r: AdminRatingDto): Promise<void> {
    const saved = await openTextDialog<AdminRatingDto>(this.dialog, {
      title: 'admin.ratings.cancelTitle',
      text: 'admin.ratings.cancelText',
      label: 'admin.reason',
      required: true,
      confirm: 'admin.ratings.cancel',
      danger: true,
      submit: (reason) => this.api.cancelRating(r.id, reason ?? ''),
    });
    if (saved) this.list.remove(r);
  }
}
