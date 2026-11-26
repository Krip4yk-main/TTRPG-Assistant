import { Directive, ElementRef, computed, inject, input, signal } from '@angular/core';

/**
 * Поведінка обкладинки-«вкладення» до картки гри — спільна для всіх дизайнів (вигляд і місце
 * задає компонент дизайну, що підключає її як `hostDirectives`). Вкладення лежить під карткою
 * (видно частину); наведення мишею виносить його наперед (у стилях дизайну: `:hover`, якщо не
 * `.dismissed`); відведення повертає. Клік / дотик / Enter / Space по кнопці всередині
 * перемикають (`.front`, `aria-pressed` — `front()`), дотик чи клік деінде повертає. Esc
 * повертає й прибирає збільшення від наведення, доки курсор не піде з вкладення (WCAG 1.4.13).
 * Фокус з клавіатури лише показує рамку фокуса — наперед виносить Enter / Space.
 *
 * Клік будь-де по вкладенню лише перемикає його — гру не відкриває (картка, що відкриває гру
 * кліком по собі, має пропускати кліки всередині вкладення). Картинка декоративна (`alt=""`) —
 * назва в aria-label кнопки. Якщо картинка не завантажилась (`onError()`), вкладення зникає
 * (`.failed`, до зміни адреси).
 *
 * Шаблон компонента дизайну: кнопка з `[attr.aria-pressed]="front()"` і `(blur)="onBlur()"`,
 * у ній `<img [src]="src()" alt="" (error)="onError()">`.
 */
@Directive({
  selector: '[nriCoverAttachment]',
  host: {
    // Клік по вкладенню — не «відкрити гру» (спільне правило карток, ../card-click.ts).
    'data-card-interactive': '',
    '[class.front]': 'front()',
    '[class.dismissed]': 'dismissed()',
    '[class.failed]': 'failed()',
    '(click)': 'toggle()',
    '(pointerdown)': 'pointerInside = true',
    '(mouseleave)': 'onLeave()',
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(document:keydown.escape)': 'dismiss()',
  },
})
export class CoverAttachment {
  /** Адреса картинки. */
  readonly src = input.required<string>();
  /** Назва гри — для aria-label кнопки. */
  readonly title = input.required<string>();

  /** Винесене наперед кліком / дотиком / клавішею; наведення мишею — у стилях (:hover). */
  readonly front = signal(false);
  /** Esc: збільшення від наведення скасовано, доки курсор не піде з вкладення. */
  readonly dismissed = signal(false);
  /** Адреса, яка не завантажилась: нова адреса знову показує вкладення. */
  private readonly failedSrc = signal<string | null>(null);
  readonly failed = computed(() => this.failedSrc() === this.src());

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  /**
   * Натиснуто всередині вкладення (до кліку): фокус, що йде з кнопки на інше місце вкладення, —
   * не «пішов геть», інакше blur закрив би його, а клік одразу відкрив би знову.
   */
  protected pointerInside = false;

  protected toggle(): void {
    this.pointerInside = false;
    this.dismissed.set(false);
    this.front.update((v) => !v);
  }

  /** Картинка не завантажилась — вкладення ховається. */
  onError(): void {
    this.failedSrc.set(this.src());
  }

  protected onLeave(): void {
    this.pointerInside = false;
    this.front.set(false);
    this.dismissed.set(false);
  }

  /** Фокус пішов з кнопки — вкладення повертається під картку. */
  onBlur(): void {
    if (this.pointerInside) return;
    this.front.set(false);
  }

  protected dismiss(): void {
    this.front.set(false);
    if (this.host.matches(':hover')) this.dismissed.set(true);
  }

  protected onDocumentPointerDown(event: PointerEvent): void {
    if (this.host.contains(event.target as Node)) return;
    this.pointerInside = false;
    if (this.front()) this.front.set(false);
  }
}
