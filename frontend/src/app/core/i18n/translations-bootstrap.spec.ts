import { Subject } from 'rxjs';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TitleStrategy, provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { authInterceptor } from '../api/auth.interceptor';
import { SocketService } from '../realtime/socket.service';
import { TranslatedTitleStrategy } from './translated-title.strategy';
import uk from '../../../assets/i18n/uk.json';

/**
 * Регресія: interceptor не повинен інжектити Router/AuthStore на кожен запит — інакше
 * запит перекладів (поки TranslateService ще конструюється) дає циклічний DI через
 * Router → TitleStrategy → TranslateService, і переклади не завантажуються.
 */
describe('завантаження перекладів з authInterceptor', () => {
  it('translate.instant повертає текст з uk.json', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: TitleStrategy, useExisting: TranslatedTitleStrategy },
        provideTranslateService({
          loader: provideTranslateHttpLoader({ prefix: '/assets/i18n/', suffix: '.json' }),
          fallbackLang: 'uk',
          lang: 'uk',
        }),
        {
          provide: SocketService,
          useValue: { connect: vi.fn(), disconnect: vi.fn(), sessionLost$: new Subject<void>() },
        },
      ],
    });
    const translate = TestBed.inject(TranslateService);
    const ctrl = TestBed.inject(HttpTestingController);

    ctrl.expectOne('/assets/i18n/uk.json').flush(uk);
    await Promise.resolve();

    expect(translate.instant('app.title')).toBe('НРІ Асистент');
    ctrl.verify();
  });
});
