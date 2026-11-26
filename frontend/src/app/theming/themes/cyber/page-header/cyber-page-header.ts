import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { PageHeaderSlot, SlotLinkAction } from '../../../slots';

/** Видимий текст вивіски, поділений для неону (див. `signParts`). */
export interface SignParts {
  /** Перше слово до «напівмертвої» літери. */
  readonly before: string;
  /** «Напівмертва» літера (порожня, якщо перше слово коротше за 4 літери). */
  readonly dead: string;
  /** Решта першого слова. */
  readonly after: string;
  /** Решта заголовка з пробілом попереду (порожня для одного слова). */
  readonly rest: string;
}

/**
 * Поділ заголовка-вивіски: перше слово й решта (дизайн може світити їх різними неонами), а в
 * першому слові з 4+ літер — третя з кінця «напівмертва» (у «Знайдіть» — «і», як у макеті).
 * Конкатенація частин — завжди вихідний текст.
 */
export function signParts(text: string): SignParts {
  const space = text.indexOf(' ');
  const first = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? '' : text.slice(space);
  const chars = Array.from(first);
  if (chars.length < 4) return { before: first, dead: '', after: '', rest };
  const i = chars.length - 3;
  return {
    before: chars.slice(0, i).join(''),
    dead: chars[i] ?? '',
    after: chars.slice(i + 1).join(''),
    rest,
  };
}

/**
 * Слот `page-header` кібер-родини: заголовок-вивіска (пластина з неоновими літерами — у
 * бандлі дизайну, `.cy-sign`), підзаголовок під нею і кнопки праворуч. Літери вивіски поділено
 * на частини (`signParts`) — це єдиний вміст заголовка (копіювання / пошук дають звичайний
 * текст); читачі екрана чують його цілим рядком (`aria-label`).
 */
@Component({
  selector: 'nri-cy-page-header',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './cyber-page-header.html',
  styleUrl: './cyber-page-header.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CyberPageHeader implements PageHeaderSlot {
  readonly titleKey = input.required<string>();
  readonly leadKey = input<string | null>(null);
  readonly actions = input<readonly SlotLinkAction[]>([]);
  protected readonly parts = signParts;
}
