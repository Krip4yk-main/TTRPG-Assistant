import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { SeoService } from './seo.service';

describe('SeoService', () => {
  let seo: SeoService;
  let meta: Meta;
  let title: Title;
  const robots = () => meta.getTag("name='robots'")?.content ?? null;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService({ lang: 'uk' })] });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', {
      app: { title: 'НРІ Асистент' },
      titles: { calendar: 'Календар' },
    });
    translate.use('uk');
    meta = TestBed.inject(Meta);
    title = TestBed.inject(Title);
    meta.removeTag("name='robots'");
    seo = TestBed.inject(SeoService);
  });

  it('noindex adds robots=noindex, the next call without it removes the tag', () => {
    seo.set({ title: 'Темна вежа', noindex: true });
    expect(robots()).toBe('noindex');
    seo.set({ title: 'Туман над Дніпром' });
    expect(robots()).toBeNull();
  });

  it('sets the title, description and Open Graph tags', () => {
    seo.set({
      title: 'Туман над Дніпром',
      description: 'Детективна   кампанія.',
      image: 'https://example.com/c.png',
    });
    expect(title.getTitle()).toBe('Туман над Дніпром — НРІ Асистент');
    expect(meta.getTag("name='description'")?.content).toBe('Детективна кампанія.');
    expect(meta.getTag("property='og:title'")?.content).toBe('Туман над Дніпром');
    expect(meta.getTag("property='og:description'")?.content).toBe('Детективна кампанія.');
    expect(meta.getTag("property='og:image'")?.content).toBe('https://example.com/c.png');

    seo.set({ titleKey: 'titles.calendar' });
    expect(title.getTitle()).toBe('Календар — НРІ Асистент');
    expect(meta.getTag("property='og:image'")).toBeNull();
  });

  it('clips long descriptions and reset() clears page tags', () => {
    seo.set({ title: 'X', description: 'а'.repeat(500), noindex: true });
    expect(meta.getTag("name='description'")!.content.length).toBe(200);
    seo.reset();
    expect(robots()).toBeNull();
    expect(meta.getTag("property='og:title'")).toBeNull();
  });
});
