import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { ComplaintDto, ComplaintStatus, SanctionType } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { AdminApi } from '../../../core/moderation/admin.api';
import { canActOn, roleAtLeast } from '../../../core/auth/roles';
import { AdminDatePipe } from '../admin-date.pipe';
import { DialogConflict } from '../dialog-conflict';
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
  /** Повідомлення після 409 (скаргу вже розглянув хтось інший) — ключ i18n. */
  protected readonly notice = signal<string | null>(null);
  private readonly myRole = computed(() => this.auth.me()?.role ?? 'user');

  constructor() {
    void this.list.reload();
  }

  protected setFilter(f: Filter): void {
    if (f === this.filter()) return;
    this.filter.set(f);
    this.notice.set(null);
    void this.list.reload();
  }

  /**
   * Типи санкцій, доступні за цією скаргою; `null` — «Вжити заходів» не показується. Людина з
   * рівною чи вищою роллю (зокрема власник щодо скарг на себе) — лише відхилити; видалений
   * акаунт — лише бан (адміну й власнику). Роль майстра гри тут невідома — вирішує бекенд.
   */
  protected actionTypes(c: ComplaintDto): readonly SanctionType[] | undefined | null {
    const t = c.targetUser;
    if (!t) return undefined;
    if (!canActOn(this.myRole(), t.role)) return null;
    if (t.nickname === null) return roleAtLeast(this.myRole(), 'admin') ? ['global_ban'] : null;
    return undefined;
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
    await this.settle(saved);
  }

  protected async action(c: ComplaintDto): Promise<void> {
    const types = this.actionTypes(c);
    if (types === null) return;
    const target = c.targetUser;
    const name =
      target?.nickname ??
      (c.targetGame
        ? (this.translate.instant('admin.complaints.gmOf', { title: c.targetGame.title }) as string)
        : (this.translate.instant('user.deleted') as string));
    const saved = await openSanctionDialog<ComplaintDto>(this.dialog, {
      name,
      actorRole: this.myRole(),
      gmOfGame: c.targetGame?.title,
      types,
      submit: (sanction) => this.api.actionComplaint(c.id, sanction),
    });
    await this.settle(saved);
  }

  /** Результат діалогу: оновлена скарга — на місце; 409 — повідомлення й перечитування. */
  private async settle(saved: ComplaintDto | DialogConflict | undefined): Promise<void> {
    if (saved instanceof DialogConflict) {
      this.notice.set(`errors.${saved.code}`);
      await this.list.reload();
    } else if (saved) {
      this.notice.set(null);
      this.list.replace(saved);
    }
  }
}
