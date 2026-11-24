import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthStore } from './auth.store';

/**
 * Якщо стан сесії невідомий (сервер недоступний) — не пускаємо на сторінку, що залежить
 * від нього, і не вважаємо користувача гостем; Shell показує банер «Спробувати ще раз».
 */
async function loaded(url: string): Promise<AuthStore | false> {
  const auth = inject(AuthStore);
  await auth.ensureLoaded();
  if (auth.isUnknown()) {
    auth.rememberBlockedUrl(url);
    return false;
  }
  return auth;
}

/** Лише залогінені (будь-який статус). */
export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = await loaded(state.url);
  if (!auth) return false;
  return auth.isAuthenticated() ? true : router.createUrlTree(['/login']);
};

/** Лише активні; pending → /complete-profile, гість → /login?returnTo=… */
export const activeGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = await loaded(state.url);
  if (!auth) return false;
  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login'], { queryParams: { returnTo: state.url } });
  }
  if (auth.isPending()) return router.createUrlTree(['/complete-profile']);
  return true;
};

/** Лише гості; pending → /complete-profile, активний → /. */
export const guestGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = await loaded(state.url);
  if (!auth) return false;
  if (!auth.isAuthenticated()) return true;
  return router.createUrlTree([auth.isPending() ? '/complete-profile' : '/']);
};

/** Сторінка завершення профілю: лише pending. */
export const pendingGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = await loaded(state.url);
  if (!auth) return false;
  if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
  return auth.isPending() ? true : router.createUrlTree(['/']);
};

/** Публічні сторінки: гостям і активним можна, pending спершу завершує профіль. */
export const notPendingGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const auth = inject(AuthStore);
  await auth.ensureLoaded();
  return auth.isPending() ? router.createUrlTree(['/complete-profile']) : true;
};
