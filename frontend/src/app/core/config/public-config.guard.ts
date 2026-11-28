import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { PublicConfigStore } from './public-config.store';

/** Пускає на сторінку лише після завантаження публічних налаштувань (не блокує інші сторінки). */
export const publicConfigGuard: CanActivateFn = async () => {
  await inject(PublicConfigStore).ensureLoaded();
  return true;
};
