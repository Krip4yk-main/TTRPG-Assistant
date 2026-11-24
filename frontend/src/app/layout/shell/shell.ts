import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatToolbarModule } from '@angular/material/toolbar';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthStore } from '../../core/auth/auth.store';
import { type ViewMode, ViewModeStore } from '../../core/view-mode/view-mode.store';
import { UserName } from '../../shared/user-name/user-name';

@Component({
  selector: 'nri-shell',
  imports: [
    RouterLink,
    RouterOutlet,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatMenuModule,
    MatToolbarModule,
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

  protected async logout(): Promise<void> {
    try {
      await this.auth.logout();
    } finally {
      await this.router.navigateByUrl('/login');
    }
  }
}
