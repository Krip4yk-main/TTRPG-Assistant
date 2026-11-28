import type { Routes } from '@angular/router';
import { devLoginRoutes } from '../environments/runtime-config';
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
  // Прихований dev-вхід бети (генерується лише для beta; поза нею порожньо).
  ...devLoginRoutes,
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
    path: 'settings/notifications',
    canActivate: [activeGuard],
    title: 'titles.notificationSettings',
    loadComponent: () =>
      import('./features/notifications/notification-settings/notification-settings').then(
        (m) => m.NotificationSettings,
      ),
  },
  {
    path: 'my-games',
    canActivate: [activeGuard],
    title: 'titles.myGames',
    loadComponent: () => import('./features/games/my-games/my-games').then((m) => m.MyGames),
  },
  {
    path: 'my-applications',
    canActivate: [activeGuard],
    title: 'titles.myApplications',
    loadComponent: () =>
      import('./features/applications/my-applications/my-applications').then(
        (m) => m.MyApplications,
      ),
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
    path: 'games/:id/applications',
    canActivate: [activeGuard],
    title: 'titles.gameApplications',
    loadComponent: () =>
      import('./features/applications/game-applications/game-applications').then(
        (m) => m.GameApplications,
      ),
  },
  {
    path: 'games/:id/rate',
    canActivate: [activeGuard],
    title: 'titles.rate',
    loadComponent: () => import('./features/ratings/rate-page/rate-page').then((m) => m.RatePage),
  },
  {
    path: 'ratings',
    canActivate: [activeGuard],
    title: 'titles.ratings',
    loadComponent: () =>
      import('./features/ratings/pending-ratings/pending-ratings').then((m) => m.PendingRatings),
  },
  {
    path: 'blacklist',
    canActivate: [activeGuard],
    title: 'titles.blacklist',
    loadComponent: () =>
      import('./features/members/blacklist-page/blacklist-page').then((m) => m.BlacklistPage),
  },
  {
    path: 'my-sanctions',
    canActivate: [activeGuard],
    title: 'titles.mySanctions',
    loadComponent: () =>
      import('./features/moderation/my-sanctions/my-sanctions').then((m) => m.MySanctions),
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
    // Розділ персоналу — окремий чанк; доступ за роллю перевіряє guard усередині.
    path: 'admin',
    loadChildren: () => import('./features/admin/admin.routes').then((m) => m.ADMIN_ROUTES),
  },
  {
    path: 'about',
    title: 'titles.about',
    loadComponent: () => import('./features/about/about').then((m) => m.About),
  },
  {
    // Неіснуюча адреса — сторінка 404 (адреса в рядку браузера лишається).
    path: '**',
    title: 'titles.notFound',
    data: { noindex: true },
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound),
  },
];
