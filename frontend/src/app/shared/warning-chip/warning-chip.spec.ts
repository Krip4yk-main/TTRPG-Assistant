import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { WarningChip } from './warning-chip';
import uk from '../../../assets/i18n/uk.json';

describe('WarningChip', () => {
  let fixture: ComponentFixture<WarningChip>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WarningChip],
      providers: [provideTranslateService({ fallbackLang: 'uk', lang: 'uk' })],
    }).compileComponents();
    TestBed.inject(TranslateService).setTranslation('uk', uk);
    fixture = TestBed.createComponent(WarningChip);
    el = fixture.nativeElement as HTMLElement;
  });

  it('catalog warning: label, focusable (i) with tooltip = hint, aria-describedby', () => {
    fixture.componentRef.setInput('slug', 'gore');
    fixture.detectChanges();
    expect(el.querySelector('.label')!.textContent).toContain(uk.warnings.gore.label);
    const info = el.querySelector<HTMLElement>('.info')!;
    expect(info.tagName).toBe('BUTTON');
    expect(info.tabIndex).toBeGreaterThanOrEqual(0);
    const tip = fixture.debugElement.query(By.directive(MatTooltip)).injector.get(MatTooltip);
    expect(tip.message).toBe(uk.warnings.gore.hint);
    const describedBy = info.getAttribute('aria-describedby')!;
    const described = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(uk.warnings.gore.hint);
  });

  it('custom warning: text only, no (i)', () => {
    fixture.componentRef.setInput('custom', 'Павуки');
    fixture.detectChanges();
    expect(el.querySelector('.label')!.textContent).toContain('Павуки');
    expect(el.querySelector('.info')).toBeNull();
    expect(fixture.debugElement.query(By.directive(MatTooltip))).toBeNull();
  });
});
