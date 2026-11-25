import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import uk from '../../../assets/i18n/uk.json';
import { routes } from '../../app.routes';
import { NotFound } from './not-found';

describe('NotFound', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideTranslateService({ fallbackLang: 'uk' })],
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
});
