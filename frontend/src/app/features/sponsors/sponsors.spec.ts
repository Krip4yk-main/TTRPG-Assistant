import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { TitleStrategy, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import uk from '../../../assets/i18n/uk.json';
import { routes } from '../../app.routes';
import { TranslatedTitleStrategy } from '../../core/i18n/translated-title.strategy';
import { Sponsors } from './sponsors';

describe('Sponsors', () => {
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

  async function open() {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/sponsors', Sponsors);
    await new Promise((r) => setTimeout(r, 0));
    harness.detectChanges();
    return { harness, page, el: harness.routeNativeElement! };
  }

  it('/sponsors is a lazy public page with its title', async () => {
    const route = routes.find((r) => r.path === 'sponsors')!;
    expect(route.loadComponent).toBeDefined();
    expect(route.component).toBeUndefined();
    expect(route.canActivate).toBeUndefined();
    const { page, el } = await open();
    expect(page).toBeInstanceOf(Sponsors);
    expect(el.querySelector('h1')!.textContent).toContain('Спонсорам');
    expect(TestBed.inject(Title).getTitle()).toBe('Спонсорам — НРІ Асистент');
  });

  it('promo: WebP srcset (1920w, 3840w), PNG fallback, fixed size, meaningful alt', async () => {
    const { el } = await open();
    const source = el.querySelector<HTMLSourceElement>('picture source[type="image/webp"]')!;
    expect(source.getAttribute('srcset')).toBe(
      'assets/promo/nri-promo-1920x1080.webp 1920w, assets/promo/nri-promo-3840x2160.webp 3840w',
    );
    expect(source.getAttribute('sizes')).toBeTruthy();
    const img = el.querySelector<HTMLImageElement>('picture img')!;
    expect(img.getAttribute('src')).toBe('assets/promo/nri-promo-1920x1080.png');
    expect(img.getAttribute('width')).toBe('1920');
    expect(img.getAttribute('height')).toBe('1080');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(source.getAttribute('sizes')).toBe('(max-width: 960px) 100vw, 960px');
    const alt = img.getAttribute('alt')!;
    for (const part of [
      'Знайди свою партію',
      'Гравцям',
      'Майстрам',
      '10 дизайнів',
      'Шукаємо спонсорів',
      't.me/krip4yk',
    ]) {
      expect(alt).toContain(part);
    }
  });

  it('the contact is a real clickable link', async () => {
    const { el } = await open();
    const link = el.querySelector<HTMLAnchorElement>('a[href="https://t.me/krip4yk"]')!;
    expect(link).not.toBeNull();
    expect(link.textContent!.trim()).toBe('t.me/krip4yk');
    expect(link.rel).toContain('noopener');
  });

  it('sets og tags with an absolute promo image; other pages drop them', async () => {
    const { harness } = await open();
    const meta = TestBed.inject(Meta);
    expect(meta.getTag("property='og:title'")?.content).toBe('Спонсорам');
    expect(meta.getTag("property='og:description'")?.content).toContain('t.me/krip4yk');
    const image = meta.getTag("property='og:image'")?.content ?? '';
    expect(image).toMatch(/^https?:\/\/.+\/assets\/promo\/nri-promo-og\.jpg$/);
    expect(meta.getTag('name="robots"')).toBeNull();
    await harness.navigateByUrl('/about');
    expect(meta.getTag("property='og:image'")).toBeNull();
    expect(meta.getTag("property='og:title'")).toBeNull();
  });
});
