import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatTabsModule } from '@angular/material/tabs';
import { TranslatePipe } from '@ngx-translate/core';
import type { UserRole } from '@nri/shared';
import { AuthStore } from '../../../core/auth/auth.store';
import { roleAtLeast } from '../../../core/auth/roles';

interface AdminTab {
  path: string;
  label: string;
  min: UserRole;
}

const TABS: readonly AdminTab[] = [
  { path: 'complaints', label: 'admin.tabs.complaints', min: 'moderator' },
  { path: 'users', label: 'admin.tabs.users', min: 'moderator' },
  { path: 'appeals', label: 'admin.tabs.appeals', min: 'moderator' },
  { path: 'ratings', label: 'admin.tabs.ratings', min: 'moderator' },
  { path: 'dead-games', label: 'admin.tabs.deadGames', min: 'moderator' },
  { path: 'roles', label: 'admin.tabs.roles', min: 'admin' },
  { path: 'catalog', label: 'admin.tabs.catalog', min: 'admin' },
  { path: 'log', label: 'admin.tabs.log', min: 'admin' },
  { path: 'tester-reports', label: 'admin.tabs.testerReports', min: 'admin' },
];

/** Каркас розділу «Адмінка»: заголовок і вкладки за роллю (навігація маршрутами). */
@Component({
  selector: 'nri-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, MatTabsModule, TranslatePipe],
  templateUrl: './admin-shell.html',
  styleUrl: './admin-shell.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminShell {
  private readonly auth = inject(AuthStore);
  protected readonly tabs = computed(() => {
    const role = this.auth.me()?.role;
    return TABS.filter((t) => roleAtLeast(role, t.min));
  });
}
