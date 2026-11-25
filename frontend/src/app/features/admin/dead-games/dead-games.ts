import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import { type AdminDeadGameDto, DEAD_GAME_KINDS, type DeadGameKind } from '@nri/shared';
import { AdminApi } from '../../../core/moderation/admin.api';
import { AdminDatePipe } from '../admin-date.pipe';
import { DialogConflict } from '../dialog-conflict';
import { openTextDialog } from '../dialogs';
import { Paged } from '../paged';
import { AdminPager } from '../pager/pager';
import { AdminUserRef } from '../user-ref/user-ref';

/**
 * Вкладка «Мертві ігри» (модератор+): «мертві» (понад 90 днів без проведених сесій) і
 * «підозрілі» (сесії часто накладаються) ігри. «Закрити гру» — з позначкою «закрита
 * адміністрацією» й сповіщенням майстру; «Зняти позначку» — гра звільняється від перевірки
 * (до наступної проведеної сесії / на 4 тижні). Обидві дії — з необов'язковою приміткою в
 * діалозі підтвердження; після дії гра зникає зі списку.
 */
@Component({
  selector: 'nri-admin-dead-games',
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    TranslatePipe,
    AdminDatePipe,
    AdminPager,
    AdminUserRef,
  ],
  templateUrl: './dead-games.html',
  styleUrls: ['../admin-list.less', './dead-games.less'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminDeadGames {
  private readonly api = inject(AdminApi);
  private readonly dialog = inject(MatDialog);

  protected readonly kinds = DEAD_GAME_KINDS;
  protected readonly kind = signal<DeadGameKind>('dead');
  protected readonly list = new Paged<AdminDeadGameDto>((cursor) =>
    this.api.deadGames(this.kind(), cursor),
  );

  /** Повідомлення після 409 (гру вже закрито чи позначку знято) — ключ i18n. */
  protected readonly notice = signal<string | null>(null);

  constructor() {
    void this.list.reload();
  }

  protected setKind(kind: DeadGameKind): void {
    if (kind === this.kind()) return;
    this.kind.set(kind);
    this.notice.set(null);
    void this.list.reload();
  }

  protected async close(g: AdminDeadGameDto): Promise<void> {
    const saved = await openTextDialog<AdminDeadGameDto>(this.dialog, {
      title: 'admin.deadGames.closeTitle',
      text: 'admin.deadGames.closeText',
      params: { title: g.title },
      label: 'admin.note',
      required: false,
      confirm: 'admin.deadGames.close',
      danger: true,
      submit: (reason) => this.api.closeDeadGame(g.id, reason),
    });
    this.settle(g, saved);
  }

  protected async dismiss(g: AdminDeadGameDto): Promise<void> {
    const kind = this.kind();
    const saved = await openTextDialog<AdminDeadGameDto>(this.dialog, {
      title: 'admin.deadGames.dismissTitle',
      text: `admin.deadGames.dismissText.${kind}`,
      params: { title: g.title },
      label: 'admin.note',
      required: false,
      confirm: 'admin.deadGames.dismiss',
      submit: (reason) => this.api.dismissDeadGame(g.id, kind, reason),
    });
    this.settle(g, saved);
  }

  /** Після дії (чи 409 — стан уже інший) гра зникає зі списку. */
  private settle(g: AdminDeadGameDto, saved: AdminDeadGameDto | DialogConflict | undefined): void {
    if (!saved) return;
    this.notice.set(saved instanceof DialogConflict ? `errors.${saved.code}` : null);
    this.list.remove(g);
  }
}
