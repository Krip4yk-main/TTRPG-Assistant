import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import type { AppealDto, SanctionAppealStatus } from '@nri/shared';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { DialogConflict } from '../dialog-conflict';
import { openTextDialog } from '../dialogs';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

type Filter = SanctionAppealStatus | 'all';

/**
 * Перенесене з `ban_appeals` рішення: розглянуто, але без того, хто вирішив (міграція).
 * Нові рішення завжди мають `decidedBy`.
 */
export function isMigratedDecision(a: AppealDto): boolean {
  return a.status !== 'pending' && a.decidedBy === null;
}

/**
 * Черга апеляцій на санкції (бекенд показує лише ті, які переглядач може вирішити): санкція,
 * повідомлення людини й рішення. На розгляді — «Задовольнити» (знімає чинну санкцію) чи
 * «Відхилити», обидва з необов'язковою приміткою для людини.
 */
@Component({
  selector: 'nri-admin-appeals',
  imports: [
    MatButtonModule,
    MatButtonToggleModule,
    TranslatePipe,
    AdminDatePipe,
    AdminPager,
    AdminUserRef,
  ],
  templateUrl: './appeals.html',
  styleUrls: ['../admin-list.less', './appeals.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminAppeals {
  private readonly api = inject(AdminApi);
  private readonly dialog = inject(MatDialog);

  protected readonly filters: readonly Filter[] = ['pending', 'accepted', 'rejected', 'all'];
  protected readonly filter = signal<Filter>('pending');
  protected readonly list = new Paged<AppealDto>((cursor) => {
    const f = this.filter();
    return this.api.appeals(f === 'all' ? null : f, cursor);
  });
  protected readonly migrated = isMigratedDecision;
  /** Повідомлення після 409 (апеляцію вже вирішено) — ключ i18n. */
  protected readonly notice = signal<string | null>(null);

  constructor() {
    void this.list.reload();
  }

  protected setFilter(f: Filter): void {
    if (f === this.filter()) return;
    this.filter.set(f);
    this.notice.set(null);
    void this.list.reload();
  }

  protected async decide(a: AppealDto, accept: boolean): Promise<void> {
    const saved = await openTextDialog<AppealDto>(this.dialog, {
      title: accept ? 'admin.appeals.acceptTitle' : 'admin.appeals.rejectTitle',
      text: accept ? 'admin.appeals.acceptText' : 'admin.appeals.rejectText',
      label: 'admin.appeals.note',
      required: false,
      confirm: accept ? 'admin.appeals.accept' : 'admin.appeals.reject',
      danger: !accept,
      submit: (note) => this.api.decideAppeal(a.id, { accept, note }),
    });
    if (saved instanceof DialogConflict) {
      this.notice.set(`errors.${saved.code}`);
      await this.list.reload();
    } else if (saved) {
      this.notice.set(null);
      this.list.replace(saved);
    }
  }
}
