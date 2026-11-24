import type { Routes } from '@angular/router';
import { activeGuard, guestGuard, notPendingGuard, pendingGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [notPendingGuard],
    title: 'titles.home',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'titles.login',
    loadComponent: () => import('./features/auth/login/login').then((m) => m.Login),
  },
  {
    path: 'complete-profile',
    canActivate: [pendingGuard],
    title: 'titles.completeProfile',
    loadComponent: () =>
      import('./features/auth/complete-profile/complete-profile').then((m) => m.CompleteProfile),
  },
  {
    path: 'account',
    canActivate: [activeGuard],
    title: 'titles.account',
    loadComponent: () =>
      import('./features/account/account-settings/account-settings').then((m) => m.AccountSettings),
  },
  {
    path: 'about',
    title: 'titles.about',
    loadComponent: () => import('./features/about/about').then((m) => m.About),
  },
  { path: '**', redirectTo: '' },
];
