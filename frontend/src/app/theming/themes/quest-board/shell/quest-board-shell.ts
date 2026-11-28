import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslatePipe } from '@ngx-translate/core';
import { ShellController } from '../../../../layout/shell/shell-controller';
import { UserName } from '../../../../shared/user-name/user-name';
import { BrandMark } from '../../../../shared/brand-mark/brand-mark';
import { NotificationBell } from '../../../../features/notifications/notification-bell/notification-bell';
import { RateLink } from '../../../../features/ratings/rate-link/rate-link';
import { SanctionsBanner } from '../../../../features/moderation/sanctions-banner/sanctions-banner';
import { GuestThemeToggle } from '../../../guest-theme-toggle/guest-theme-toggle';
import type { ShellSlot } from '../../../slots';

/**
 * Слот `shell` дизайну «Дошка оголошень»: дерев'яна планка-шапка (герб, навігація, перемикач
 * виду, дзвіночок, латунний кружок акаунта), дерев'яна стіна під сторінкою, планка-підвал.
 * На вузькому екрані навігація ховається в меню. Логіка — `ShellController`.
 */
@Component({
  selector: 'nri-qb-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatMenuModule,
    GuestThemeToggle,
    NotificationBell,
    RateLink,
    SanctionsBanner,
    TranslatePipe,
    UserName,
    BrandMark,
  ],
  templateUrl: './quest-board-shell.html',
  styleUrl: './quest-board-shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'qb-wall' },
})
export class QuestBoardShell implements ShellSlot {
  protected readonly shell = inject(ShellController);
  protected readonly auth = this.shell.auth;
  protected readonly viewMode = this.shell.viewMode;

  /** Літера в латунному кружку акаунта (декор; назва кнопки — «Меню акаунта»). */
  protected readonly initial = computed(() => {
    const nick = this.auth.me()?.nickname?.trim();
    return nick ? Array.from(nick)[0]!.toUpperCase() : null;
  });
}
