import type { Routes } from '@angular/router';
import { activeGuard, guestGuard, notPendingGuard, pendingGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [notPendingGuard],
    title: 'titles.home',
    // Вид майстра — «Мої ігри», вид гравця (і гість) — пошук ігор.
    loadComponent: () => import('./features/home/home-page/home-page').then((m) => m.HomePage),
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
    path: 'my-games',
    canActivate: [activeGuard],
    title: 'titles.myGames',
    loadComponent: () => import('./features/games/my-games/my-games').then((m) => m.MyGames),
  },
  {
    path: 'games/new',
    canActivate: [activeGuard],
    title: 'titles.newGame',
    loadComponent: () => import('./features/games/game-form/game-form').then((m) => m.GameForm),
  },
  {
    path: 'games/:id/edit',
    canActivate: [activeGuard],
    title: 'titles.editGame',
    loadComponent: () => import('./features/games/game-form/game-form').then((m) => m.GameForm),
  },
  {
    path: 'games/:id',
    title: 'titles.game',
    loadComponent: () =>
      import('./features/games/game-details/game-details').then((m) => m.GameDetails),
  },
  {
    path: 'users/:publicId',
    title: 'titles.profile',
    loadComponent: () =>
      import('./features/profile/profile-page/profile-page').then((m) => m.ProfilePage),
  },
  {
    path: 'profile/edit',
    canActivate: [activeGuard],
    title: 'titles.profileEdit',
    loadComponent: () =>
      import('./features/profile/profile-edit/profile-edit').then((m) => m.ProfileEdit),
  },
  {
    path: 'calendar',
    canActivate: [activeGuard],
    title: 'titles.calendar',
    loadComponent: () =>
      import('./features/calendar/calendar-page/calendar-page').then((m) => m.CalendarPage),
  },
  {
    path: 'about',
    title: 'titles.about',
    loadComponent: () => import('./features/about/about').then((m) => m.About),
  },
  { path: '**', redirectTo: '' },
];
