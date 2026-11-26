import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslatePipe } from '@ngx-translate/core';
import { ShellController } from '../../../../layout/shell/shell-controller';
import { UserName } from '../../../../shared/user-name/user-name';
import { NotificationBell } from '../../../../features/notifications/notification-bell/notification-bell';
import { RateLink } from '../../../../features/ratings/rate-link/rate-link';
import { SanctionsBanner } from '../../../../features/moderation/sanctions-banner/sanctions-banner';
import type { ShellSlot } from '../../../slots';

/**
 * Слот `shell` кібер-родини: темна смуга-шапка з неоновим знаком, навігація (активна — з
 * неоновим підкресленням), перемикач виду, дзвіночок, кружок акаунта з неоновим обідком;
 * під сторінкою — стіна дизайну (`.cy-wall`, малюнок — у бандлі дизайну), смуга-підвал.
 * На вузькому екрані навігація ховається в меню. Логіка — `ShellController`.
 */
@Component({
  selector: 'nri-cy-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatMenuModule,
    NotificationBell,
    RateLink,
    SanctionsBanner,
    TranslatePipe,
    UserName,
  ],
  templateUrl: './cyber-shell.html',
  styleUrl: './cyber-shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cy-wall' },
})
export class CyberShell implements ShellSlot {
  protected readonly shell = inject(ShellController);
  protected readonly auth = this.shell.auth;
  protected readonly viewMode = this.shell.viewMode;

  /** Літера в кружку акаунта (декор; назва кнопки — «Меню акаунта»). */
  protected readonly initial = computed(() => {
    const nick = this.auth.me()?.nickname?.trim();
    return nick ? Array.from(nick)[0]!.toUpperCase() : null;
  });
}
