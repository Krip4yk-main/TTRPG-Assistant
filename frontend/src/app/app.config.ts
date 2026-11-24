import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import { TitleStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { MAT_ICON_DEFAULT_OPTIONS } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { routes } from './app.routes';
import { authInterceptor } from './core/api/auth.interceptor';
import { AuthStore } from './core/auth/auth.store';
import { TranslatedTitleStrategy } from './core/i18n/translated-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useExisting: TranslatedTitleStrategy },
    // Бекенд ставить куку nri_csrf на будь-який GET; Angular дублює її в заголовок
    // для всіх не-GET запитів на той самий origin.
    provideHttpClient(
      withXsrfConfiguration({ cookieName: 'nri_csrf', headerName: 'X-CSRF-Token' }),
      // 401 посеред сесії → очищення стану й перехід на /login?returnTo=…
      withInterceptors([authInterceptor]),
    ),
    provideTranslateService({
      loader: provideTranslateHttpLoader({ prefix: '/assets/i18n/', suffix: '.json' }),
      fallbackLang: 'uk',
      lang: 'uk',
    }),
    { provide: MAT_ICON_DEFAULT_OPTIONS, useValue: { fontSet: 'material-symbols-outlined' } },
    // Перше завантаження /api/me (і кука CSRF) — до першої навігації.
    provideAppInitializer(() => inject(AuthStore).load()),
  ],
};
