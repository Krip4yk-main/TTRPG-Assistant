import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { ScenePageHeader, signParts } from './scene-page-header';

describe('signParts', () => {
  it('splits the first word around its «half-dead» letter (third from the end)', () => {
    expect(signParts('Знайдіть свою гру')).toEqual({
      before: 'Знайд',
      dead: 'і',
      after: 'ть',
      rest: ' свою гру',
    });
  });

  it('a short first word has no dead letter; one word has no rest', () => {
    expect(signParts('Мої ігри')).toEqual({ before: 'Мої', dead: '', after: '', rest: ' ігри' });
    expect(signParts('Налаштування')).toMatchObject({ dead: 'н', rest: '' });
  });

  it('the parts always join back into the original text', () => {
    for (const t of ['Знайдіть свою гру', 'Мої ігри', 'Нова гра', 'Гра', '', 'Адмін-панель']) {
      const p = signParts(t);
      expect(p.before + p.dead + p.after + p.rest).toBe(t);
    }
  });
});

describe('ScenePageHeader (slot «page-header»)', () => {
  it('the heading text is the title once; screen readers get it as one string', async () => {
    await TestBed.configureTestingModule({
      imports: [ScenePageHeader],
      providers: [provideRouter([]), provideTranslateService()],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', {
      search: { title: 'Знайдіть свою гру' },
      scene: { graffiti: 'нижче — цікавіше' },
    });
    translate.use('uk');
    const fixture = TestBed.createComponent(ScenePageHeader);
    fixture.componentRef.setInput('titleKey', 'search.title');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    // Як getByRole('heading', { name }): заголовок знаходиться за доступною назвою
    // (aria-label, інакше текст) — і він один.
    const headings = [
      ...host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]'),
    ];
    const named = headings.filter(
      (h) => (h.getAttribute('aria-label') ?? h.textContent!.trim()) === 'Знайдіть свою гру',
    );
    expect(named).toHaveLength(1);
    const h1 = named[0]!;
    expect(h1.tagName).toBe('H1');
    // Копіювання, пошук на сторінці, innerText — один раз, без зайвих пробілів між частинами.
    expect(h1.textContent!.trim()).toBe('Знайдіть свою гру');
    expect(h1.getAttribute('aria-label')).toBe('Знайдіть свою гру');
    expect(h1.querySelector('[aria-hidden], .nri-visually-hidden')).toBeNull();
    expect(h1.querySelector('.sc-sign-mark')!.textContent).toBe('і');
    // Текст графіті для декору дизайну — атрибут поза заголовком (у тексті сторінки його немає).
    const header = host.querySelector('.page-header')!;
    expect(header.getAttribute('data-graffiti')).toBe('нижче — цікавіше');
    expect(header.textContent).not.toContain('нижче');
  });
});
