import type { Routes } from '@angular/router';
import { staffGuard } from './admin.guards';
import { AdminShell } from './admin-shell/admin-shell';

/**
 * Розділ `/admin` (окремий чанк). Вкладки «Скарги», «Користувачі», «Апеляції», «Відгуки» —
 * модератору й вище; «Ролі» і «Журнал» — адміну й власнику.
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
        path: 'roles',
        title: 'titles.admin',
        canActivate: [staffGuard('admin')],
        loadComponent: () => import('./roles/roles').then((m) => m.AdminRoles),
      },
      {
        path: 'log',
        title: 'titles.admin',
        canActivate: [staffGuard('admin')],
        loadComponent: () => import('./log/log').then((m) => m.AdminLog),
      },
    ],
  },
];
