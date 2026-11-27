import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { Clipboard } from '@angular/cdk/clipboard';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { CalendarFeedStatusDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { CalendarFeedApi } from '../../../core/calendar/calendar-feed.api';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

interface Message {
  kind: 'error' | 'info';
  key: string;
}

/**
 * «Мої сесії у вашому календарі» на сторінці «Мій календар»: секретне ICS-посилання на сесії
 * ігор користувача. Посилання видно лише одразу після створення/перевипуску (сервер не
 * повертає його повторно); після перезавантаження — «Підключено з <дата>» і «Перевипустити».
 */
@Component({
  selector: 'nri-calendar-feed',
  imports: [MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './calendar-feed.html',
  styleUrl: './calendar-feed.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CalendarFeed {
  private readonly api = inject(CalendarFeedApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly clipboard = inject(Clipboard);
  private readonly announcer = inject(LiveAnnouncer);
  private readonly translate = inject(TranslateService);

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly status = signal<CalendarFeedStatusDto | null>(null);
  /** Щойно видане посилання — лише в пам'яті компонента. */
  protected readonly url = signal<string | null>(null);
  protected readonly busy = signal<'issue' | 'disable' | null>(null);
  protected readonly message = signal<Message | null>(null);

  protected readonly since = computed(() => {
    const at = this.status()?.createdAt;
    return at ? formatDateTime(at, viewerTimeZone(this.auth.me())) : null;
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      this.status.set(await firstValueFrom(this.api.status()));
      this.state.set('ready');
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.state.set('error');
    }
  }

  /** «Підключити» або «Перевипустити» (друге — після підтвердження). */
  protected async issue(reissue: boolean): Promise<void> {
    if (this.busy()) return;
    if (
      reissue &&
      !(await this.confirm({
        title: 'calendar.feed.reissueConfirm.title',
        text: 'calendar.feed.reissueConfirm.text',
        confirm: 'calendar.feed.reissueConfirm.confirm',
        danger: true,
      }))
    ) {
      return;
    }
    this.busy.set('issue');
    this.message.set(null);
    try {
      const created = await firstValueFrom(this.api.issue());
      this.url.set(created.url);
      this.status.set({ enabled: true, createdAt: created.createdAt });
      this.message.set({
        kind: 'info',
        key: reissue ? 'calendar.feed.reissued' : 'calendar.feed.enabled',
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async disable(): Promise<void> {
    if (this.busy()) return;
    const ok = await this.confirm({
      title: 'calendar.feed.disableConfirm.title',
      text: 'calendar.feed.disableConfirm.text',
      confirm: 'calendar.feed.disableConfirm.confirm',
      danger: true,
    });
    if (!ok) return;
    this.busy.set('disable');
    this.message.set(null);
    try {
      await firstValueFrom(this.api.disable());
      this.url.set(null);
      this.status.set({ enabled: false, createdAt: null });
      this.message.set({ kind: 'info', key: 'calendar.feed.disabled' });
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected copy(): void {
    const url = this.url();
    if (!url) return;
    if (this.clipboard.copy(url)) {
      void this.announcer.announce(this.translate.instant('calendar.feed.copied'), 'polite');
    } else {
      this.message.set({ kind: 'error', key: 'calendar.feed.copyFailed' });
    }
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    return !!(await firstValueFrom(ref.afterClosed()));
  }

  private fail(err: unknown): void {
    const { code } = toApiError(err);
    if (code === 'UNAUTHENTICATED') return;
    this.message.set({ kind: 'error', key: `errors.${code}` });
  }
}
