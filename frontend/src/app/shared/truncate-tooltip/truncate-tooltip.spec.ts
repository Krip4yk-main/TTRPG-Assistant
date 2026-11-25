import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatTooltip } from '@angular/material/tooltip';
import { TruncateTooltip } from './truncate-tooltip';

@Component({ imports: [TruncateTooltip], templateUrl: './truncate-tooltip.spec.html' })
class Host {
  text = 'Дуже довга назва';
}

describe('TruncateTooltip', () => {
  const setup = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const de = fixture.debugElement.query(By.css('.cut'));
    return { el: de.nativeElement as HTMLElement, tooltip: de.injector.get(MatTooltip) };
  };

  const size = (el: HTMLElement, scroll: number, client: number) => {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: client });
  };

  it('passes the full text to the Material tooltip without touch gestures', () => {
    const { tooltip } = setup();
    expect(tooltip.message).toBe('Дуже довга назва');
    expect(tooltip.touchGestures).toBe('off');
  });

  it('enables the tooltip only when the text is actually truncated', () => {
    const { el, tooltip } = setup();
    size(el, 100, 100);
    el.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tooltip.disabled).toBe(true);
    size(el, 300, 100);
    el.dispatchEvent(new MouseEvent('mouseenter'));
    expect(tooltip.disabled).toBe(false);
  });
});
