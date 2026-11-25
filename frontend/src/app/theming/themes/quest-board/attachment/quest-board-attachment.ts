import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Обкладинка гри на дошці — «вкладка» до оголошення: маленька картинка в рамці, підкладена
 * під аркуш у його верхньому правому куті (видно частину). Наведення (на пристроях з мишею)
 * чи фокус з клавіатури виносять її наперед: вона виходить поверх аркуша, вирівнюється й
 * збільшується; відведення / втрата фокуса / Esc повертають назад. На сенсорних екранах (без
 * наведення) — дотик перемикає, дотик деінде повертає.
 *
 * Це кнопка: клік по ній не відкриває гру (картка пропускає кліки по інтерактивних
 * елементах). Картинка декоративна (`alt=""`) — назва в aria-label кнопки. Якщо картинка не
 * завантажилась, вкладка зникає.
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
    '[class.failed]': 'failed()',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class QuestBoardAttachment {
  /** Адреса картинки. */
  readonly src = input.required<string>();
  /** Назва гри — для aria-label кнопки. */
  readonly title = input.required<string>();

  /** Винесена наперед (дотик, клавіатура); наведення мишею — у стилях (:hover). */
  protected readonly front = signal(false);
  /** Картинка не завантажилась — вкладку сховано. */
  protected readonly failed = signal(false);

  private readonly host: HTMLElement = inject(ElementRef).nativeElement;

  protected toggle(): void {
    this.front.update((v) => !v);
  }

  /** Фокус з клавіатури (не клік мишею) — наперед. */
  protected onFocus(event: FocusEvent): void {
    const el = event.target as HTMLElement;
    if (el.matches(':focus-visible')) this.front.set(true);
  }

  protected back(): void {
    this.front.set(false);
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.front() && !this.host.contains(event.target as Node)) this.front.set(false);
  }
}
