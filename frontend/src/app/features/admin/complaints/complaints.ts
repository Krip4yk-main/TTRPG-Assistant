import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { ComplaintDto, ComplaintStatus } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { openSanctionDialog, openTextDialog } from '../dialogs';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

type Filter = ComplaintStatus | 'all';

/**
 * Черга скарг: фільтр за статусом (типово — нові), картка зі скаржником (якщо його видно),
 * ціллю й текстом; для нових — «Відхилити» (з приміткою) і «Вжити заходів» (діалог санкції;
 * скарга на гру карає її майстра).
 */
@Component({
  selector: 'nri-admin-complaints',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    TranslatePipe,
    AdminDatePipe,
    AdminPager,
    AdminUserRef,
  ],
  templateUrl: './complaints.html',
  styleUrls: ['../admin-list.less', './complaints.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminComplaints {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);

  protected readonly filters: readonly Filter[] = ['new', 'dismissed', 'actioned', 'all'];
  protected readonly filter = signal<Filter>('new');
  protected readonly list = new Paged<ComplaintDto>((cursor) => {
    const f = this.filter();
    return this.api.complaints(f === 'all' ? null : f, cursor);
  });
  protected readonly items = computed(() => this.list.items());

  constructor() {
    void this.list.reload();
  }

  protected setFilter(f: Filter): void {
    if (f === this.filter()) return;
    this.filter.set(f);
    void this.list.reload();
  }

  protected async dismiss(c: ComplaintDto): Promise<void> {
    const saved = await openTextDialog<ComplaintDto>(this.dialog, {
      title: 'admin.complaints.dismissTitle',
      text: 'admin.complaints.dismissText',
      label: 'admin.note',
      required: false,
      confirm: 'admin.complaints.dismiss',
      submit: (note) => this.api.dismissComplaint(c.id, note),
    });
    if (saved) this.list.replace(saved);
  }

  protected async action(c: ComplaintDto): Promise<void> {
    const target = c.targetUser;
    const name =
      target?.nickname ??
      (c.targetGame
        ? (this.translate.instant('admin.complaints.gmOf', { title: c.targetGame.title }) as string)
        : (this.translate.instant('user.deleted') as string));
    const saved = await openSanctionDialog<ComplaintDto>(this.dialog, {
      name,
      actorRole: this.auth.me()?.role ?? 'user',
      gmOfGame: c.targetGame?.title,
      submit: (sanction) => this.api.actionComplaint(c.id, sanction),
    });
    if (saved) this.list.replace(saved);
  }
}
