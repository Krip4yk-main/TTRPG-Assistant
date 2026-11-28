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
import { PublicConfigStore } from './core/config/public-config.store';
import { TranslatedTitleStrategy } from './core/i18n/translated-title.strategy';
import { ViewModeRouting } from './core/view-mode/view-mode-routing';
import { ThemeService } from './theming/theme.service';

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
    // Перше завантаження /api/me (і кука CSRF) — до першої навігації; потім чинний дизайн
    // (права з /me) і його слоти — до першого рендера, без мигання. Вид за сторінкою
    // (`ViewModeRouting`) слухає роутер ще до першої навігації.
    provideAppInitializer(async () => {
      // Публічні налаштування — паралельно, без очікування: першому рендеру не заважають.
      void inject(PublicConfigStore).ensureLoaded();
      const auth = inject(AuthStore);
      const theme = inject(ThemeService);
      inject(ViewModeRouting);
      await auth.load();
      await theme.init();
    }),
  ],
};
