import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { Router, TitleStrategy, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import uk from '../../../assets/i18n/uk.json';
import { routes } from '../../app.routes';
import { TranslatedTitleStrategy } from '../../core/i18n/translated-title.strategy';
import { NotFound } from './not-found';

describe('NotFound', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideTranslateService({ fallbackLang: 'uk' }),
        { provide: TitleStrategy, useExisting: TranslatedTitleStrategy },
      ],
    });
    TestBed.inject(TranslateService).setTranslation('uk', uk);
    TestBed.inject(TranslateService).use('uk');
  });

  it('an unknown address shows the 404 page instead of redirecting home', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/no/such/page', NotFound);
    expect(page).toBeInstanceOf(NotFound);
    expect(TestBed.inject(Router).url).toBe('/no/such/page');
    const el = harness.routeNativeElement!;
    expect(el.querySelector('h1')!.textContent).toContain('Сторінку не знайдено');
    const home = el.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    harness.detectChanges();
    expect(TestBed.inject(Title).getTitle()).toContain('Сторінку не знайдено');
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex');
  });

  it('noindex survives navigation between two unknown addresses (component reused)', async () => {
    const harness = await RouterTestingHarness.create();
    const first = await harness.navigateByUrl('/missing/one', NotFound);
    const second = await harness.navigateByUrl('/missing/two', NotFound);
    expect(second).toBe(first);
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex');
    // Звичайна сторінка після 404 — знову без noindex.
    await harness.navigateByUrl('/about');
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });
});
