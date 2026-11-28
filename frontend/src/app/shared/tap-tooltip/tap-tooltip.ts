import { DOCUMENT } from '@angular/common';
import { DestroyRef, Directive, ElementRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatTooltip } from '@angular/material/tooltip';
import { take } from 'rxjs';

/** Дотиковий екран: наведення немає або вказівник грубий. */
export const COARSE_POINTER_QUERY = '(hover: none), (pointer: coarse)';

/**
 * Пояснення за натисканням на дотикових екранах — для кнопки (i) з `matTooltip` на тому самому
 * елементі (`<button matTooltip="…" nriTapTooltip>`). На десктопі — підказка Material як є
 * (наведення, фокус з клавіатури). На `pointer: coarse` / `hover: none` натискання (i) відкриває
 * ту саму підказку (оформлену токенами дизайну), будь-яке наступне натискання — деінде чи на
 * самій (i) — або Esc її ховає; фокус не перехоплюється. Довге натискання Material вимкнено,
 * щоб не сперечалося з натисканням. `aria-expanded` на кнопці показує, чи відкрите пояснення;
 * сам текст зачитується через `aria-describedby`, який додає `matTooltip`. Стан іде за справжньою
 * видимістю: якщо Material сховає підказку сам (прокрутка тощо), кнопка теж «закривається».
 * Esc, поки пояснення відкрите, закриває лише його (не діалог навколо).
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
  private readonly destroyRef = inject(DestroyRef);

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
    this.destroyRef.onDestroy(() => {
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
    const instance = this.tooltip._tooltipInstance;
    if (!instance) return;
    this.open.set(true);
    // Сховали (ми чи сам Material) — пояснення закрите.
    instance
      .afterHidden()
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // Панель сховано й знято (Material завершує `afterHidden` при знятті, і саме це —
        // надійний сигнал: емісію наш підписник може не отримати) — якщо це досі наша підказка;
        // запізніле «сховано» від попередньої нову не закриває.
        complete: () => {
          const current = this.tooltip._tooltipInstance;
          if (!current || current === instance) this.closed();
        },
      });
    // Поточне натискання вже пройшло (`click` — після `pointerdown`): слухаємо наступні.
    this.doc.addEventListener('pointerdown', this.onOutside, true);
    this.doc.addEventListener('keydown', this.onKey, true);
  }

  private close(): void {
    if (!this.open()) return;
    this.tooltip.hide(0);
    this.closed();
  }

  private closed(): void {
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

  /** Esc закриває лише пояснення — далі (діалогу) не йде. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.open()) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };
}
