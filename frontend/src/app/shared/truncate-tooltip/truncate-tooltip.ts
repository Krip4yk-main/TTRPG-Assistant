import { DestroyRef, Directive, ElementRef, afterNextRender, inject } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';

/**
 * Повний текст обрізаного рядка (ellipsis / line-clamp) — у підказці Material
 * (`[nriTruncateTooltip]="повний текст"`). Підказка ввімкнена лише тоді, коли текст справді
 * не вміщається: стан оновлюється при зміні розміру елемента (ResizeObserver) і перед кожним
 * наведенням, тож і фокус з клавіатури бачить актуальний стан. На сенсорних екранах підказки
 * немає (довге натискання не перехоплюється) — повний текст є на сторінці гри.
 */
@Directive({
  selector: '[nriTruncateTooltip]',
  hostDirectives: [{ directive: MatTooltip, inputs: ['matTooltip: nriTruncateTooltip'] }],
  host: { '(mouseenter)': 'sync()' },
})
export class TruncateTooltip {
  private readonly el: HTMLElement = inject(ElementRef).nativeElement;
  private readonly tooltip = inject(MatTooltip);

  constructor() {
    this.tooltip.touchGestures = 'off';
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.sync());
      observer.observe(this.el);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Обрізаний — коли вміст ширший / вищий за видиму частину елемента. */
  protected sync(): void {
    const { scrollWidth, clientWidth, scrollHeight, clientHeight } = this.el;
    this.tooltip.disabled = !(scrollWidth > clientWidth + 1 || scrollHeight > clientHeight + 1);
  }
}
