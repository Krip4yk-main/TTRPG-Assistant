import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import type { BlacklistEntryDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { MembersApi } from '../../../core/members/members.api';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Повідомлення сторінки: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
  name?: string;
}

/** Чорний список майстра (`/blacklist`): хто не може подавати заявки на мої ігри; «Розбанити». */
@Component({
  selector: 'nri-blacklist-page',
  imports: [RouterLink, MatButtonModule, TranslatePipe],
  templateUrl: './blacklist-page.html',
  styleUrl: './blacklist-page.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlacklistPage {
  private readonly api = inject(MembersApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);

  protected readonly entries = signal<BlacklistEntryDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly message = signal<Message | null>(null);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      this.entries.set(await firstValueFrom(this.api.blacklist()));
    } catch (err) {
      if (toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }

  protected when(iso: string): string {
    return formatDateTime(iso, viewerTimeZone(this.auth.me()));
  }

  protected async unban(e: BlacklistEntryDto): Promise<void> {
    if (this.busyId() !== null) return;
    const name = e.nickname ?? '';
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: {
        title: 'members.blacklist.confirm.title',
        text: 'members.blacklist.confirm.text',
        confirm: 'members.blacklist.confirm.confirm',
        params: { name },
      },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busyId.set(e.publicId);
    this.message.set(null);
    try {
      await firstValueFrom(this.api.removeFromBlacklist(e.publicId));
      this.entries.update((list) => (list ?? []).filter((x) => x.publicId !== e.publicId));
      this.message.set({ kind: 'info', key: 'members.blacklist.removed', name });
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      this.message.set({ kind: 'error', key: `errors.${code}` });
      void this.load();
    } finally {
      this.busyId.set(null);
    }
  }
}
