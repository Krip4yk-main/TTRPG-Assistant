import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { CyberPageHeader, signParts } from './cyber-page-header';

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

describe('CyberPageHeader (slot «page-header»)', () => {
  it('screen readers get the plain heading text; the split neon letters are hidden', async () => {
    await TestBed.configureTestingModule({
      imports: [CyberPageHeader],
      providers: [provideRouter([]), provideTranslateService()],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('uk', { search: { title: 'Знайдіть свою гру' } });
    translate.use('uk');
    const fixture = TestBed.createComponent(CyberPageHeader);
    fixture.componentRef.setInput('titleKey', 'search.title');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const h1 = (fixture.nativeElement as HTMLElement).querySelector('h1')!;
    const plain = h1.querySelector('.nri-visually-hidden')!;
    expect(plain.textContent).toBe('Знайдіть свою гру');
    expect(plain.closest('[aria-hidden]')).toBeNull();
    const lit = h1.querySelector('.cy-sign-lit')!;
    expect(lit.getAttribute('aria-hidden')).toBe('true');
    expect(lit.textContent).toBe('Знайдіть свою гру');
    expect(lit.querySelector('.cy-sign-dead')!.textContent).toBe('і');
  });
});
