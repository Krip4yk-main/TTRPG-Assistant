import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthStore } from './auth.store';

/** Лише залогінені (будь-який статус). */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  await auth.ensureLoaded();
  return auth.isAuthenticated() ? true : inject(Router).createUrlTree(['/login']);
};

/** Лише активні; pending → /complete-profile, гість → /login. */
export const activeGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
  if (auth.isPending()) return router.createUrlTree(['/complete-profile']);
  return true;
};

/** Лише гості; pending → /complete-profile, активний → /. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (!auth.isAuthenticated()) return true;
  return router.createUrlTree([auth.isPending() ? '/complete-profile' : '/']);
};

/** Сторінка завершення профілю: лише pending. */
export const pendingGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.ensureLoaded();
  if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
  return auth.isPending() ? true : router.createUrlTree(['/']);
};

/** Публічні сторінки: гостям і активним можна, pending спершу завершує профіль. */
export const notPendingGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  await auth.ensureLoaded();
  return auth.isPending() ? inject(Router).createUrlTree(['/complete-profile']) : true;
};
