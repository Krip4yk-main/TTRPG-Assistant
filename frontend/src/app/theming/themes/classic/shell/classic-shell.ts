import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { TranslatePipe } from '@ngx-translate/core';
import { ShellController } from '../../../../layout/shell/shell-controller';
import { UserName } from '../../../../shared/user-name/user-name';
import { NotificationBell } from '../../../../features/notifications/notification-bell/notification-bell';
import { RateLink } from '../../../../features/ratings/rate-link/rate-link';
import { SanctionsBanner } from '../../../../features/moderation/sanctions-banner/sanctions-banner';
import type { ShellSlot } from '../../../slots';

/** Слот `shell` дизайну «Класичний»: тулбар Material, меню акаунта, підвал. */
@Component({
  selector: 'nri-classic-shell',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatMenuModule,
    MatToolbarModule,
    NotificationBell,
    RateLink,
    SanctionsBanner,
    TranslatePipe,
    UserName,
  ],
  templateUrl: './classic-shell.html',
  styleUrl: './classic-shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClassicShell implements ShellSlot {
  protected readonly shell = inject(ShellController);
  protected readonly auth = this.shell.auth;
  protected readonly viewMode = this.shell.viewMode;
}
