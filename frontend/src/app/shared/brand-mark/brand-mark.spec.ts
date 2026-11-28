import { TestBed } from '@angular/core/testing';
import { BrandMark } from './brand-mark';

describe('BrandMark', () => {
  it('розмір задає ширину й висоту хоста, svg прихований від читачів екрана', () => {
    const fixture = TestBed.createComponent(BrandMark);
    fixture.componentRef.setInput('size', 40);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.style.width).toBe('40px');
    expect(host.style.height).toBe('40px');
    expect(host.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    fixture.componentRef.setInput('size', 20);
    fixture.detectChanges();
    expect(host.style.width).toBe('20px');
  });

  it('розмір за замовчуванням — 30 px', () => {
    const fixture = TestBed.createComponent(BrandMark);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).style.width).toBe('30px');
  });
});
