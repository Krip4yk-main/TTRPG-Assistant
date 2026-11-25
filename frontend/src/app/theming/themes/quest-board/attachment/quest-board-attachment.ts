import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Обкладинка гри на дошці — «вкладка» до оголошення: маленька картинка в рамці, підкладена
 * під аркуш у його верхньому правому куті (видно частину). Наведення мишею виносить її
 * наперед: вона виходить поверх аркуша, вирівнюється й збільшується; відведення повертає.
 * Клік / дотик / Enter / Space перемикають (`aria-pressed`), дотик чи клік деінде повертає.
 * Esc повертає й прибирає збільшення від наведення, доки курсор не піде з вкладки (WCAG 1.4.13).
 * Фокус з клавіатури лише показує рамку фокуса — наперед виносить Enter / Space.
 *
 * Клік будь-де по вкладці (і по кнопці, і по місцю, звідки картинка виїхала) лише перемикає
 * її — гру не відкриває (картка пропускає кліки всередині `nri-qb-attachment`). Картинка
 * декоративна (`alt=""`) — назва в aria-label кнопки. Якщо картинка не завантажилась, вкладка
 * зникає (до зміни адреси).
 *
 * Місце вкладки (top / right) задає оголошення, вигляд і рух — тут.
 */
@Component({
  selector: 'nri-qb-attachment',
  imports: [TranslatePipe],
  templateUrl: './quest-board-attachment.html',
  styleUrl: './quest-board-attachment.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.front]': 'front()',
    '[class.dismissed]': 'dismissed()',
    '[class.failed]': 'failed()',
    '(click)': 'toggle()',
    '(mouseleave)': 'onLeave()',
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(document:keydown.escape)': 'dismiss()',
  },
})
export class QuestBoardAttachment {
  /** Адреса картинки. */
  readonly src = input.required<string>();
  /** Назва гри — для aria-label кнопки. */
  readonly title = input.required<string>();

  /** Винесена наперед кліком / дотиком / клавішею; наведення мишею — у стилях (:hover). */
  protected readonly front = signal(false);
  /** Esc: збільшення від наведення скасовано, доки курсор не піде з вкладки. */
  protected readonly dismissed = signal(false);
  /** Адреса, яка не завантажилась: нова адреса знову показує вкладку. */
  private readonly failedSrc = signal<string | null>(null);
  protected readonly failed = computed(() => this.failedSrc() === this.src());

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  protected toggle(): void {
    this.dismissed.set(false);
    this.front.update((v) => !v);
  }

  protected onError(): void {
    this.failedSrc.set(this.src());
  }

  protected onLeave(): void {
    this.front.set(false);
    this.dismissed.set(false);
  }

  /** Фокус пішов з кнопки — вкладка повертається під аркуш. */
  protected onBlur(): void {
    this.front.set(false);
  }

  protected dismiss(): void {
    this.front.set(false);
    if (this.host.matches(':hover')) this.dismissed.set(true);
  }

  protected onDocumentPointerDown(event: PointerEvent): void {
    if (this.front() && !this.host.contains(event.target as Node)) this.front.set(false);
  }
}
