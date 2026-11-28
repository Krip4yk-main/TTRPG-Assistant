import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, inject, signal } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';

/** Дотиковий екран: наведення немає або вказівник грубий. */
export const COARSE_POINTER_QUERY = '(hover: none), (pointer: coarse)';

/**
 * Пояснення за натисканням на дотикових екранах — для кнопки (i) з `matTooltip` на тому самому
 * елементі (`<button matTooltip="…" nriTapTooltip>`). На десктопі — підказка Material як є
 * (наведення, фокус з клавіатури). На `pointer: coarse` / `hover: none` натискання (i) відкриває
 * ту саму підказку (оформлену токенами дизайну), будь-яке наступне натискання — деінде чи на
 * самій (i) — або Esc її ховає; фокус не перехоплюється. Довге натискання Material вимкнено,
 * щоб не сперечалося з натисканням. `aria-expanded` на кнопці показує, чи відкрите пояснення;
 * сам текст зачитується через `aria-describedby`, який додає `matTooltip`.
 */
@Directive({
  selector: '[nriTapTooltip]',
  host: {
    '(pointerdown)': 'remember()',
    '(click)': 'toggle()',
    '[attr.aria-expanded]': 'coarse() ? open() : null',
  },
})
export class TapTooltip {
  private readonly tooltip = inject(MatTooltip);
  private readonly el: HTMLElement = inject(ElementRef).nativeElement;
  private readonly doc = inject(DOCUMENT);
  private readonly media = this.doc.defaultView?.matchMedia?.(COARSE_POINTER_QUERY) ?? null;

  protected readonly coarse = signal(!!this.media?.matches);
  protected readonly open = signal(false);
  /**
   * Стан на момент `pointerdown` на кнопці: емульовані після дотику події миші можуть уже
   * показати підказку Material до `click`, тож вирішуємо за власним станом до них.
   */
  private wasOpen: boolean | null = null;

  constructor() {
    if (this.coarse()) this.tooltip.touchGestures = 'off';
    const onMedia = (e: MediaQueryListEvent) => {
      this.coarse.set(e.matches);
      if (e.matches) this.tooltip.touchGestures = 'off';
      else this.close();
    };
    this.media?.addEventListener?.('change', onMedia);
    inject(DestroyRef).onDestroy(() => {
      this.media?.removeEventListener?.('change', onMedia);
      this.unlisten();
    });
  }

  protected remember(): void {
    this.wasOpen = this.open();
  }

  protected toggle(): void {
    if (!this.coarse()) return;
    const wasOpen = this.wasOpen ?? this.open();
    this.wasOpen = null;
    if (wasOpen) this.close();
    else this.show();
  }

  private show(): void {
    this.tooltip.show(0);
    this.open.set(true);
    // Поточне натискання вже пройшло (`click` — після `pointerdown`): слухаємо наступні.
    this.doc.addEventListener('pointerdown', this.onOutside, true);
    this.doc.addEventListener('keydown', this.onKey, true);
  }

  private close(): void {
    if (!this.open()) return;
    this.tooltip.hide(0);
    this.open.set(false);
    this.unlisten();
  }

  private unlisten(): void {
    this.doc.removeEventListener('pointerdown', this.onOutside, true);
    this.doc.removeEventListener('keydown', this.onKey, true);
  }

  /** Натискання деінде ховає; на самій (i) — вирішить `toggle` (закриє). */
  private readonly onOutside = (e: Event): void => {
    if (e.target instanceof Node && this.el.contains(e.target)) return;
    this.close();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };
}
