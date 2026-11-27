import type { Routes } from '@angular/router';
import { devEnvMatch, staffGuard } from './admin.guards';
import { AdminShell } from './admin-shell/admin-shell';

/**
 * Розділ `/admin` (окремий чанк). Вкладки «Скарги», «Користувачі», «Апеляції», «Відгуки»,
 * «Мертві ігри» — модератору й вище; «Ролі», «Каталог» і «Журнал» — адміну й власнику.
 * «Звіти тестерів» — адміну й власнику, лише на dev-сервері (поза dev вкладка прихована, а адреса — «не знайдено»).
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminShell,
    canActivate: [staffGuard('moderator')],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'complaints' },
      {
        path: 'complaints',
        title: 'titles.admin',
        loadComponent: () => import('./complaints/complaints').then((m) => m.AdminComplaints),
      },
      {
        path: 'users',
        title: 'titles.admin',
        loadComponent: () => import('./users/users').then((m) => m.AdminUsers),
      },
      {
        path: 'users/:publicId',
        title: 'titles.admin',
        loadComponent: () => import('./user-card/user-card').then((m) => m.AdminUserCard),
      },
      {
        path: 'appeals',
        title: 'titles.admin',
        loadComponent: () => import('./appeals/appeals').then((m) => m.AdminAppeals),
      },
      {
        path: 'ratings',
        title: 'titles.admin',
        loadComponent: () => import('./ratings/ratings').then((m) => m.AdminRatings),
      },
      {
        path: 'dead-games',
        title: 'titles.admin',
        loadComponent: () => import('./dead-games/dead-games').then((m) => m.AdminDeadGames),
      },
      {
        path: 'roles',
        title: 'titles.admin',
        canActivate: [staffGuard('admin')],
        loadComponent: () => import('./roles/roles').then((m) => m.AdminRoles),
      },
      {
        path: 'catalog',
        title: 'titles.admin',
        canActivate: [staffGuard('admin')],
        loadComponent: () => import('./catalog/catalog').then((m) => m.AdminCatalog),
      },
      {
        path: 'log',
        title: 'titles.admin',
        canActivate: [staffGuard('admin')],
        loadComponent: () => import('./log/log').then((m) => m.AdminLog),
      },
      {
        path: 'tester-reports',
        title: 'titles.admin',
        canMatch: [devEnvMatch()],
        canActivate: [staffGuard('admin')],
        loadComponent: () =>
          import('./tester-reports/tester-reports').then((m) => m.AdminTesterReports),
      },
    ],
  },
];
