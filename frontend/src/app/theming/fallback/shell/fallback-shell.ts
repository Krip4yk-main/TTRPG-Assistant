import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ShellController } from '../../../layout/shell/shell-controller';
import { NotificationBell } from '../../../features/notifications/notification-bell/notification-bell';
import { RateLink } from '../../../features/ratings/rate-link/rate-link';
import { SanctionsBanner } from '../../../features/moderation/sanctions-banner/sanctions-banner';
import { BrandMark } from '../../../shared/brand-mark/brand-mark';
import type { ShellSlot } from '../../slots';

/**
 * Резервний каркас (чанк дизайну ще вантажиться або не завантажився): ті самі посилання й
 * дії, що в дизайнах, але простою розміткою без Material-тулбара й декору.
 */
@Component({
  selector: 'nri-fallback-shell',
  imports: [
    RouterLink,
    RouterOutlet,
    TranslatePipe,
    NotificationBell,
    RateLink,
    SanctionsBanner,
    BrandMark,
  ],
  templateUrl: './fallback-shell.html',
  styleUrl: './fallback-shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FallbackShell implements ShellSlot {
  protected readonly shell = inject(ShellController);
  protected readonly auth = this.shell.auth;
  protected readonly viewMode = this.shell.viewMode;
}
