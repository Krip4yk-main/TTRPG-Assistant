import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthStore } from '../../core/auth/auth.store';
import { type ViewMode, ViewModeStore } from '../../core/view-mode/view-mode.store';
import { UserName } from '../../shared/user-name/user-name';
import { NotificationBell } from '../../features/notifications/notification-bell/notification-bell';
import { RateLink } from '../../features/ratings/rate-link/rate-link';
import { SanctionsBanner } from '../../features/moderation/sanctions-banner/sanctions-banner';

@Component({
  selector: 'nri-shell',
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
  templateUrl: './shell.html',
  styleUrl: './shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  protected readonly auth = inject(AuthStore);
  protected readonly viewMode = inject(ViewModeStore);
  private readonly router = inject(Router);

  protected setMode(mode: ViewMode): void {
    this.viewMode.setMode(mode);
  }

  protected readonly retrying = signal(false);

  protected async logout(): Promise<void> {
    try {
      await this.auth.logout();
    } catch {
      // Локальний стан уже очищено; сесію на сервері можна завершити пізніше.
    } finally {
      await this.router.navigateByUrl('/login');
    }
  }

  /** Повторна перевірка сесії після збою сервера/мережі. */
  protected async retry(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      await this.auth.load();
      if (!this.auth.loadFailed()) {
        const blocked = this.auth.takeBlockedUrl();
        if (blocked) await this.router.navigateByUrl(blocked);
      }
    } finally {
      this.retrying.set(false);
    }
  }
}
