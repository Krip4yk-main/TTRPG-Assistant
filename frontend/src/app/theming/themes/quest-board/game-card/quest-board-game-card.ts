import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm, GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { QuestBoardBadge } from '../badge/quest-board-badge';
import { QuestBoardGmSignature } from '../gm-signature/quest-board-gm-signature';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { LinePipe } from '../../../../core/i18n/line.pipe';
import { ThemeService } from '../../../theme.service';

/** Скільки різних нахилів має дошка (набір кутів — у стилях, `data-tilt`). */
const TILTS = 6;
/** Скільки бейджів-штампів видно в рядку (решта — «+N»): рядок не переноситься. */
const MAX_STAMPS = 3;
/** Тривалість анімації відривання (як у `qb-tear` з quest-board.less), мс. */
export const TEAR_MS = 520;
/** Інтерактивні елементи всередині оголошення мають власну дію — клік по них не відкриває гру. */
const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"]';

/**
 * Слот `game-card` дизайну «Дошка оголошень»: оголошення, приколоте шпилькою до стіни.
 * Збіг з розкладом — стрічка з моху, ціна — сургучна печатка, далі «Коли / Де / Місця» і
 * підпис майстра. Обмежена картка — лише назва, вік і майстер під «завісою». Розмір
 * оголошення сталий: довгі рядки обрізаються «…», повний текст — у підказці.
 *
 * Усе оголошення клікабельне — відкриває сторінку гри (як посилання-назва, яке лишається
 * головною дією для клавіатури й дає звичне «відкрити в новій вкладці»). Якщо в профілі ввімкнено
 * анімацію (і немає prefers-reduced-motion), аркуш спершу відривається від шпильки.
 */
@Component({
  selector: 'nri-qb-game-card',
  imports: [
    RouterLink,
    MatIconModule,
    TranslatePipe,
    QuestBoardBadge,
    QuestBoardGmSignature,
    TruncateTooltip,
    LinePipe,
  ],
  templateUrl: './quest-board-game-card.html',
  styleUrl: './quest-board-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Клік по всьому оголошенню (для миші; з клавіатури головна дія — посилання-назва, клік по
  // ньому спливає сюди ж). Аркуш, що падає, — над сусідніми оголошеннями.
  host: { '(click)': 'onCardClick($event)', '[class.leaving]': 'tearing()' },
})
export class QuestBoardGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();
  protected readonly maxStamps = MAX_STAMPS;

  /** Нахил з набору за id гри: стабільний між перерисовками й сторінками. */
  protected readonly tilt = computed(() => Math.abs(this.game().id) % TILTS);
  /** Перший збіг з розкладом — стрічкою вгорі; решта бейджів — штампами під системою. */
  protected readonly ribbon = computed<BadgeVm | null>(
    () => this.game().badges.find((b) => b.kind === 'fit') ?? null,
  );
  protected readonly stamps = computed(() => {
    const ribbon = this.ribbon();
    return this.game().badges.filter((b) => b !== ribbon);
  });

  private readonly router = inject(Router);
  private readonly themes = inject(ThemeService);
  protected readonly gameUrl = computed(() => `/games/${this.game().id}`);
  /** Анімацію ввімкнено в профілі (гість — так): тоді й текст оголошення не виділяється. */
  protected readonly tearEnabled = computed(() => this.themes.uiPrefs().tearAnimation);
  protected readonly tearing = signal(false);
  /** Перехід уже почався — повторний клік (подвійний) нічого не робить. */
  private leaving = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  protected onCardClick(event: MouseEvent): void {
    // Середня кнопка й клік з модифікатором — звична поведінка посилання (нова вкладка тощо).
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element;
    const interactive = target.closest(INTERACTIVE);
    if (interactive && !interactive.classList.contains('open')) return;
    // Виділення тексту (анімацію вимкнено, щоб копіювати) — не перехід.
    if (!interactive && document.getSelection()?.toString()) return;
    event.preventDefault();
    this.open();
  }

  private open(): void {
    if (this.leaving) return;
    this.leaving = true;
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.tearEnabled() || reduced) {
      this.navigate();
      return;
    }
    this.tearing.set(true);
    this.timer = setTimeout(() => this.navigate(), TEAR_MS);
  }

  private navigate(): void {
    this.timer = null;
    void this.router.navigateByUrl(this.gameUrl()).then((ok) => {
      // Перехід скасовано (guard) — оголошення повертається на місце.
      if (!ok) {
        this.leaving = false;
        this.tearing.set(false);
      }
    });
  }
}
