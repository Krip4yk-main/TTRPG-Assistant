import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  effect,
  Injector,
  inject,
  input,
} from '@angular/core';
import { AriaDescriber } from '@angular/cdk/a11y';
import { MatTooltip } from '@angular/material/tooltip';

/** Елементи, які й так отримують фокус з клавіатури. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * Повний текст обрізаного рядка (ellipsis / line-clamp) — у підказці Material
 * (`[nriTruncateTooltip]="повний текст"`). Підказка ввімкнена лише тоді, коли текст справді
 * не вміщається: стан оновлюється при зміні тексту, розміру елемента (ResizeObserver),
 * перед наведенням і при фокусі.
 *
 * Клавіатура: обрізаний елемент, який сам не фокусується (абзац, `dd`), на час обрізання
 * отримує `tabindex="0"` — підказку можна відкрити фокусом. Читачі екрана й так читають повний
 * текст елемента, тож підказка не додає `aria-describedby` (без дубля). На сенсорних екранах
 * підказки немає — повний текст є на сторінці гри.
 */
@Directive({
  selector: '[nriTruncateTooltip]',
  hostDirectives: [MatTooltip],
  host: { '(mouseenter)': 'sync()', '(focusin)': 'sync()' },
  providers: [
    {
      provide: AriaDescriber,
      useValue: { describe: () => undefined, removeDescription: () => undefined },
    },
  ],
})
export class TruncateTooltip {
  /** Повний текст. */
  readonly nriTruncateTooltip = input<string | null | undefined>('');

  private readonly el: HTMLElement = inject(ElementRef).nativeElement;
  private readonly tooltip = inject(MatTooltip);
  private readonly injector = inject(Injector);
  /** Чи елемент фокусується сам (тоді tabindex не чіпаємо). */
  private readonly ownFocus = this.el.matches(FOCUSABLE);

  constructor() {
    this.tooltip.touchGestures = 'off';
    effect(() => {
      this.tooltip.message = this.nriTruncateTooltip() ?? '';
      // Новий текст — нова довжина: перевірити після відмальовування.
      afterNextRender(() => this.sync(), { injector: this.injector });
    });
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
    // По висоті — допуск у пів рядка: виносні елементи останнього рядка line-clamp дають
    // кілька пікселів «переповнення» навіть без обрізання.
    const slack = parseFloat(getComputedStyle(this.el).lineHeight) / 2 || 4;
    const truncated = scrollWidth > clientWidth + 1 || scrollHeight > clientHeight + slack;
    this.tooltip.disabled = !truncated;
    if (this.ownFocus) return;
    if (truncated) this.el.setAttribute('tabindex', '0');
    else this.el.removeAttribute('tabindex');
  }
}
