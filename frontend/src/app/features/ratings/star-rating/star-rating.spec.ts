import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { StarRating } from './star-rating';

describe('StarRating', () => {
  let fixture: ComponentFixture<StarRating>;
  let el: HTMLElement;

  async function create(value: number | null = null) {
    await TestBed.configureTestingModule({
      imports: [StarRating],
      providers: [provideTranslateService()],
    }).compileComponents();
    fixture = TestBed.createComponent(StarRating);
    fixture.componentRef.setInput('labelledBy', 'overall-label');
    fixture.componentRef.setInput('required', true);
    fixture.componentRef.setInput('value', value);
    el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const group = () => el.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const radios = () => [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = () => radios().map((r) => r.getAttribute('aria-checked'));
  const key = async (k: string) => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('is a labelled, required radiogroup of five radios with "n of 5" labels', async () => {
    await create();
    expect(group().getAttribute('aria-labelledby')).toBe('overall-label');
    expect(group().getAttribute('aria-required')).toBe('true');
    expect(radios()).toHaveLength(5);
    expect(radios().map((r) => r.getAttribute('aria-label'))).toEqual(
      Array(5).fill('ratings.stars.of'),
    );
    expect(checked()).toEqual(['false', 'false', 'false', 'false', 'false']);
    // Без вибору в порядку Tab — лише перша зірка; видно «не вибрано».
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(el.querySelector('.value')!.textContent).toContain('ratings.stars.none');
  });

  it('click selects; only the selected radio is checked and tabbable', async () => {
    await create();
    radios()[3]!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(4);
    expect(checked()).toEqual(['false', 'false', 'false', 'true', 'false']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    expect(el.querySelector('.value')!.textContent).toContain('ratings.stars.of');
  });

  it('arrow keys move the choice and focus (wrapping), Home/End jump to the ends', async () => {
    await create(2);
    radios()[1]!.focus();
    await key('ArrowRight');
    expect(fixture.componentInstance.value()).toBe(3);
    expect(document.activeElement).toBe(radios()[2]);
    await key('ArrowUp');
    expect(fixture.componentInstance.value()).toBe(4);
    await key('ArrowLeft');
    await key('ArrowDown');
    expect(fixture.componentInstance.value()).toBe(2);
    await key('End');
    expect(fixture.componentInstance.value()).toBe(5);
    expect(document.activeElement).toBe(radios()[4]);
    await key('ArrowRight');
    expect(fixture.componentInstance.value()).toBe(1);
    await key('ArrowLeft');
    expect(fixture.componentInstance.value()).toBe(5);
    await key('Home');
    expect(fixture.componentInstance.value()).toBe(1);
    expect(checked()[0]).toBe('true');
  });

  it('from no choice, ArrowRight picks 1 and ArrowLeft picks 5', async () => {
    await create();
    radios()[0]!.focus();
    await key('ArrowRight');
    expect(fixture.componentInstance.value()).toBe(1);
    fixture.componentInstance.value.set(null);
    fixture.detectChanges();
    radios()[0]!.focus();
    await key('ArrowLeft');
    expect(fixture.componentInstance.value()).toBe(5);
  });

  it('marks itself invalid when asked', async () => {
    await create();
    fixture.componentRef.setInput('invalid', true);
    fixture.detectChanges();
    expect(group().getAttribute('aria-invalid')).toBe('true');
  });
});
