import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStart, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm, GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { QuestBoardBadge } from '../badge/quest-board-badge';
import { QuestBoardGmSignature } from '../gm-signature/quest-board-gm-signature';
import { QuestBoardAttachment } from '../attachment/quest-board-attachment';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { LinePipe } from '../../../../core/i18n/line.pipe';
import { ThemeService } from '../../../theme.service';
import { noticeTilt, paperVariant } from '../paper';
import { isCardOpenClick } from '../../../shared/card-click';
import { GameOpenedMoment } from '../../../moments/game-opened';

/** Скільки бейджів-штампів видно в рядку (решта — «+N»): рядок не переноситься. */
const MAX_STAMPS = 3;
/** Тривалість анімації відривання (як у `qb-tear` з quest-board.less), мс. */
export const TEAR_MS = 520;
/**
 * Оголошення, що зараз відривається (одне на сторінку): клік по іншому, поки триває анімація,
 * нічого не робить — інакше перейшли б обидва.
 */
let activeTear: symbol | null = null;

/**
 * Слот `game-card` дизайну «Дошка оголошень»: оголошення, приколоте шпилькою до стіни.
 * Збіг з розкладом — стрічка з моху, ціна — сургучна печатка, під назвою — короткий опис,
 * далі «Коли / Де / Місця» і підпис майстра. Обкладинка — вкладка під аркушем (виходить
 * наперед при наведенні чи кліку). Обмежена картка — лише назва, вік і майстер під «завісою».
 * Розмір оголошення сталий: довгі рядки обрізаються «…», повний текст — у підказці.
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
    QuestBoardAttachment,
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

  /** «Випадковий» нахил і зсув за id гри: стабільні між перерисовками й сторінками. */
  protected readonly tilt = computed(() => noticeTilt(this.game().id));
  /** Обрис пергаменту за id гри (спільне правило з «Моїми іграми»). */
  protected readonly paper = computed(() => paperVariant(this.game().id));
  /** Перший збіг з розкладом — стрічкою вгорі; решта бейджів — штампами під системою. */
  protected readonly ribbon = computed<BadgeVm | null>(
    () => this.game().badges.find((b) => b.kind === 'fit') ?? null,
  );
  protected readonly stamps = computed(() => {
    const ribbon = this.ribbon();
    return this.game().badges.filter((b) => b !== ribbon);
  });

  private readonly router = inject(Router);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  private readonly themes = inject(ThemeService);
  private readonly gameOpened = inject(GameOpenedMoment);
  protected readonly gameUrl = computed(() => `/games/${this.game().id}`);
  /** Анімацію ввімкнено в профілі (гість — так): тоді й текст оголошення не виділяється. */
  protected readonly tearEnabled = computed(() => this.themes.uiPrefs().tearAnimation);
  protected readonly tearing = signal(false);
  /** Перехід уже почався — повторний клік (подвійний) нічого не робить. */
  private leaving = false;
  /** Позначка цього оголошення для `activeTear`. */
  private readonly tearToken = Symbol('tear');
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
    // Інший перехід (назад, посилання в шапці) під час анімації — скасовуємо свій.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (this.timer) this.reset();
      });
  }

  protected onCardClick(event: MouseEvent): void {
    // Користувач виділяє текст цього оголошення (лише коли анімацію вимкнено — інакше текст
    // не виділяється) — не перехід. Вкладка-обкладинка й інші інтерактивні елементи — теж ні.
    if (!isCardOpenClick(event, this.host, { respectSelection: !this.tearEnabled() })) return;
    event.preventDefault();
    this.open();
  }

  private open(): void {
    if (this.leaving || activeTear) return;
    this.leaving = true;
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.tearEnabled() || reduced) {
      this.navigate();
      return;
    }
    activeTear = this.tearToken;
    this.tearing.set(true);
    this.timer = setTimeout(() => this.navigate(), TEAR_MS);
  }

  private navigate(): void {
    this.timer = null;
    this.gameOpened.fromCard(this.game().id);
    // Перехід скасовано (guard) чи впав — оголошення повертається на місце, а не лишається
    // «відірваним».
    this.router.navigateByUrl(this.gameUrl()).then(
      (ok) => {
        if (!ok) this.reset();
      },
      () => this.reset(),
    );
  }

  /** Повернути оголошення на місце й звільнити «одне відривання на сторінку». */
  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.leaving = false;
    this.tearing.set(false);
    if (activeTear === this.tearToken) activeTear = null;
  }
}
