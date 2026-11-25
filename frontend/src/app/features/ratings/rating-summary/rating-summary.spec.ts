import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import type { PublishedRatingDto } from '@nri/shared';
import { RatingSummary } from './rating-summary';
import uk from '../../../../assets/i18n/uk.json';

describe('RatingSummary', () => {
  let fixture: ComponentFixture<RatingSummary>;
  let el: HTMLElement;

  async function render(rating: PublishedRatingDto | null, kind: 'gm' | 'player' = 'gm') {
    await TestBed.configureTestingModule({
      imports: [RatingSummary],
      providers: [provideTranslateService({ lang: 'uk' })],
    }).compileComponents();
    const tr = TestBed.inject(TranslateService);
    tr.setTranslation('uk', uk);
    tr.use('uk');
    fixture = TestBed.createComponent(RatingSummary);
    fixture.componentRef.setInput('rating', rating);
    fixture.componentRef.setInput('kind', kind);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('null: "no rating yet (5 ratings needed)" and no numbers', async () => {
    await render(null);
    expect(el.textContent!.trim()).toBe('Ще немає рейтингу (потрібно 5 оцінок)');
    expect(el.querySelector('.overall')).toBeNull();
  });

  it('value: "4,6 · 12 оцінок" with Ukrainian plural forms', async () => {
    await render({ overall: 4.6, units: 12, criteria: {} });
    expect(el.querySelector('.overall')!.textContent!.replace(/\s+/g, ' ')).toContain(
      '4,6 · 12 оцінок',
    );
    expect(el.querySelector('.criteria')).toBeNull();
    TestBed.resetTestingModule();
    await render({ overall: 4, units: 21, criteria: {} });
    expect(el.querySelector('.overall')!.textContent).toContain('4,0');
    expect(el.querySelector('.overall')!.textContent).toContain('21 оцінка');
    TestBed.resetTestingModule();
    await render({ overall: 3.5, units: 23, criteria: {} });
    expect(el.querySelector('.overall')!.textContent).toContain('23 оцінки');
  });

  it('lists only published criteria with names, in the role order', async () => {
    await render({ overall: 4.4, units: 7, criteria: { safety: 4.9, preparation: 4.1 } });
    const rows = [...el.querySelectorAll<HTMLElement>('.criterion')];
    expect(rows.map((r) => r.dataset['criterion'])).toEqual(['preparation', 'safety']);
    expect(rows[0]!.textContent).toContain('Підготовка');
    expect(rows[0]!.textContent).toContain('4,1');
    expect(rows[1]!.textContent).toContain('Безпека й комфорт');
  });

  it('player kind uses the player criteria names', async () => {
    await render({ overall: 4.4, units: 7, criteria: { teamplay: 4.5 } }, 'player');
    expect(el.querySelector('[data-criterion="teamplay"]')!.textContent).toContain('Командна гра');
  });
});
