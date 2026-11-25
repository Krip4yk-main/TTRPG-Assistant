import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import type { MemberDto } from '@nri/shared';
import { firstValueFrom, type Observable } from 'rxjs';
import { toApiError } from '../../../core/api/api-error';
import { AuthStore } from '../../../core/auth/auth.store';
import { formatDateTime, viewerTimeZone } from '../../../core/i18n/dates';
import { MembersApi } from '../../../core/members/members.api';
import {
  ConfirmDialog,
  type ConfirmDialogData,
} from '../../../shared/confirm-dialog/confirm-dialog';

/** Дія майстра з учасником. */
export type MemberAction = 'kick' | 'ban' | 'blacklist';

/** Повідомлення панелі: ключ i18n. */
interface Message {
  kind: 'error' | 'info';
  key: string;
  name?: string;
}

/**
 * Склад гри (сторінка гри — майстру й учасникам). Майстер має меню для кожного учасника:
 * «Виключити» / «Забанити в цій грі» (лише поки гра триває чи набирає) і «Додати в мій
 * чорний список»; кожна дія — після підтвердження.
 */
@Component({
  selector: 'nri-members-panel',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatMenuModule, TranslatePipe],
  templateUrl: './members-panel.html',
  styleUrl: './members-panel.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MembersPanel {
  private readonly api = inject(MembersApi);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly gameId = input.required<number>();
  /** Глядач — майстер цієї гри (показує меню керування). */
  readonly isGm = input(false);
  /** Гра `recruiting`/`started`: можна виключати й банити. */
  readonly manageable = input(false);
  /** Склад змінився (виключення чи бан) — сторінці варто оновити вільні місця. */
  readonly changed = output<void>();

  protected readonly members = signal<MemberDto[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<Message | null>(null);

  constructor() {
    effect(() => {
      void this.load(this.gameId());
    });
  }

  protected actions(): MemberAction[] {
    return this.manageable() ? ['kick', 'ban', 'blacklist'] : ['blacklist'];
  }

  protected when(iso: string): string {
    return formatDateTime(iso, viewerTimeZone(this.auth.me()));
  }

  protected async retry(): Promise<void> {
    await this.load(this.gameId());
  }

  /** Дія з учасником — лише після підтвердження. */
  protected async run(m: MemberDto, action: MemberAction): Promise<void> {
    if (this.busy()) return;
    const name = m.nickname ?? this.translate.instant('user.deleted');
    const data: ConfirmDialogData = {
      title: `members.confirm.${action}.title`,
      text: `members.confirm.${action}.text`,
      confirm: `members.confirm.${action}.confirm`,
      params: { name },
      danger: true,
    };
    const ref = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.busy.set(true);
    this.message.set(null);
    const gameId = this.gameId();
    const request: Observable<unknown> =
      action === 'kick'
        ? this.api.kick(gameId, m.publicId)
        : action === 'ban'
          ? this.api.ban(gameId, m.publicId)
          : this.api.addToBlacklist(m.publicId);
    try {
      await firstValueFrom(request);
      if (action !== 'blacklist') {
        // Чорний список не виключає з поточних ігор (рішення власника).
        const list = this.members() ?? [];
        const index = list.findIndex((x) => x.publicId === m.publicId);
        const rest = list.filter((x) => x.publicId !== m.publicId);
        this.members.set(rest);
        this.changed.emit();
        // Фокус — на сусідній рядок (наступний, інакше попередній), а без рядків — на заголовок.
        const next = rest[Math.min(index, rest.length - 1)];
        this.focus(
          next ? `[data-member-id="${next.publicId}"] button.member-menu` : '#members-title',
        );
      }
      this.message.set({ kind: 'info', key: `members.done.${action}`, name });
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'UNAUTHENTICATED') return;
      this.message.set({ kind: 'error', key: `errors.${code}` });
      void this.load(gameId, true);
    } finally {
      this.busy.set(false);
    }
  }

  /** Фокус на елементі після рендеру (кнопки вже не `disabled`). */
  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(gameId: number, silent = false): Promise<void> {
    if (!silent) this.loadFailed.set(false);
    try {
      this.members.set(await firstValueFrom(this.api.list(gameId)));
    } catch (err) {
      if (!silent && toApiError(err).code !== 'UNAUTHENTICATED') this.loadFailed.set(true);
    }
  }
}
