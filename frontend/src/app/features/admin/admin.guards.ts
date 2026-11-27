import { inject } from '@angular/core';
import { Router, type CanActivateFn, type CanMatchFn } from '@angular/router';
import type { UserRole } from '@nri/shared';
import { AuthStore } from '../../core/auth/auth.store';
import { roleAtLeast } from '../../core/auth/roles';
import { runtimeConfig } from '../../../environments/runtime-config';

/**
 * Доступ до розділу адмінки з роллю не нижче `min` (права перевіряє й бекенд). Гість — на
 * вхід; pending — завершити профіль; недостатня роль — на головну (для вкладок адміна —
 * на першу вкладку адмінки).
 */
export function staffGuard(min: UserRole): CanActivateFn {
  return async (_route, state) => {
    const router = inject(Router);
    const auth = inject(AuthStore);
    await auth.ensureLoaded();
    if (auth.isUnknown()) {
      auth.rememberBlockedUrl(state.url);
      return false;
    }
    if (!auth.isAuthenticated()) {
      return router.createUrlTree(['/login'], { queryParams: { returnTo: state.url } });
    }
    if (auth.isPending()) return router.createUrlTree(['/complete-profile']);
    const role = auth.me()?.role;
    if (roleAtLeast(role, min)) return true;
    return router.createUrlTree(roleAtLeast(role, 'moderator') ? ['/admin'] : ['/']);
  };
}

/**
 * Маршрут існує лише на dev-сервері (`deployEnv === 'dev'`); поза dev він не збігається, і
 * адреса падає на «Сторінку не знайдено».
 */
export function devEnvMatch(deployEnv: string = runtimeConfig.deployEnv): CanMatchFn {
  return () => deployEnv === 'dev';
}
