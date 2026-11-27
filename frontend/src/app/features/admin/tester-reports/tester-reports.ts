import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { TesterReportDto, TesterReportStatus } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { TesterReportsApi } from '../../../core/tester-reports/tester-reports.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

type Filter = TesterReportStatus | 'all';

/**
 * «Відгуки» (усі середовища; адмін і власник): новіші першими, фільтр «нові /
 * опрацьовані / усі», картка з типом, текстом і контекстом, позначка «Опрацьовано».
 */
@Component({
  selector: 'nri-admin-tester-reports',
  imports: [
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    TranslatePipe,
    AdminDatePipe,
    AdminPager,
    AdminUserRef,
  ],
  templateUrl: './tester-reports.html',
  styleUrls: ['../admin-list.less', './tester-reports.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminTesterReports {
  private readonly api = inject(TesterReportsApi);

  protected readonly filters: readonly Filter[] = ['new', 'processed', 'all'];
  protected readonly filter = signal<Filter>('new');
  protected readonly list = new Paged<TesterReportDto>((cursor) => {
    const f = this.filter();
    return this.api.list(f === 'all' ? null : f, cursor);
  });
  /** Звіт, позначка якого зараз надсилається. */
  protected readonly busy = signal<number | null>(null);
  /** Помилка позначки — ключ i18n. */
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

  protected async markProcessed(r: TesterReportDto): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(r.id);
    this.notice.set(null);
    try {
      const saved = await firstValueFrom(this.api.markProcessed(r.id));
      // У фільтрі «нові» опрацьований зникає зі списку.
      if (this.filter() === 'new') this.list.remove(saved);
      else this.list.replace(saved);
    } catch (err) {
      this.notice.set(`errors.${toApiError(err).code}`);
    } finally {
      this.busy.set(null);
    }
  }
}
