import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injector, inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthStore } from '../auth/auth.store';

/** Запити, чий 401 обробляє сам викликач: початкова перевірка сесії та вхід/вихід. */
function isExempt(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (method === 'GET' && path === '/api/me') return true;
  return path.startsWith('/api/auth/');
}

/** Безпечний шлях повернення: лише внутрішній, не сторінка входу. */
export function safeReturnTo(url: string | null | undefined): string | null {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  if (url === '/' || url.startsWith('/login')) return null;
  return url;
}

/**
 * Сесія завершилася (401 на будь-якому API-запиті, крім винятків) → очищаємо стан
 * і ведемо на /login, зберігши поточну сторінку в `returnTo`. Помилка йде далі —
 * компоненти просто не показують її повторно.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // Не-API запити (зокрема завантаження перекладів під час конструювання
  // TranslateService) проходять без жодних інжекцій — інакше Router → TitleStrategy →
  // TranslateService дає циклічний DI (NG0200).
  if (!req.url.startsWith('/api/') || isExempt(req.method, req.url)) return next(req);
  // Залежності резолвимо ліниво, лише коли справді обробляємо 401.
  const injector = inject(Injector);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        const auth = injector.get(AuthStore);
        const router = injector.get(Router);
        auth.setMe(null);
        const returnTo = safeReturnTo(router.url);
        void router.navigate(['/login'], {
          queryParams: { error: 'UNAUTHENTICATED', ...(returnTo ? { returnTo } : {}) },
        });
      }
      return throwError(() => err);
    }),
  );
};
