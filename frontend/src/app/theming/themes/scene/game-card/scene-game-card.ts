import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm, GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { TruncateTooltip } from '../../../../shared/truncate-tooltip/truncate-tooltip';
import { LinePipe } from '../../../../core/i18n/line.pipe';
import { SceneBadge } from '../badge/scene-badge';
import { SceneGmSignature } from '../gm-signature/scene-gm-signature';
import { SceneAttachment } from '../attachment/scene-attachment';
import { neonOf } from '../neon';
import { isCardOpenClick } from '../../../shared/card-click';

/** Скільки міток видно в рядку системи (решта — «+N»): рядок не переноситься. */
const MAX_MARKS = 2;
/** Більше місць — без «діодів» (лише текст), щоб рядок не переповнювався. */
const MAX_PIPS = 8;

/**
 * Слот `game-card` родини сцени: панель на стіні з лінією-акцентом кольору варіанта гри
 * (`data-neon`, стабільно за id — `neonOf`). Рядок «система · тип · жанр» кольором варіанта з
 * віковою / статусною міткою, назва (до 2 рядків), короткий опис (до 3), «Коли / Де / Місця»
 * (місця — ще й «діодами»), «Підходить вашому розкладу», підпис майстра й ціна-табличка.
 * Обкладинка — знімок за верхнім правим кутом (`nri-sc-attachment`, спільна поведінка).
 *
 * Розмітка спільна для всіх дизайнів сцени: загальні гачки декору (`sc-d1…sc-d4` поза
 * панеллю, `sc-p1`, `sc-p2` у ній, `aria-hidden`) приховані основою (scene-base.less — там і
 * карта гачків), а показує й малює їх бандл свого дизайну (що чим є — у шапці бандла; напр.
 * у «Нічному місті» — шина живлення й затискачі з діодами). Розмір картки сталий: довгі
 * рядки — «…» з підказкою.
 * Обмежена картка — лише назва, вік і майстер під «завісою».
 *
 * Уся картка клікабельна — відкриває сторінку гри (як посилання-назва, яке лишається головною
 * дією для клавіатури й дає звичне «відкрити в новій вкладці»; його клік спливає сюди ж).
 * Клік по обкладинці, інших посиланнях і кнопках, з модифікатором чи після виділення тексту
 * картки гру не відкриває (спільне правило `isCardOpenClick`); без анімації відривання.
 */
@Component({
  selector: 'nri-sc-game-card',
  imports: [
    RouterLink,
    MatIconModule,
    TranslatePipe,
    SceneBadge,
    SceneGmSignature,
    SceneAttachment,
    TruncateTooltip,
    LinePipe,
  ],
  templateUrl: './scene-game-card.html',
  styleUrl: './scene-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-neon]': 'neon()', '(click)': 'onCardClick($event)' },
})
export class SceneGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();
  protected readonly maxMarks = MAX_MARKS;

  /** Колір неону за id гри (спільне правило з «Моїми іграми»). */
  protected readonly neon = computed(() => neonOf(this.game().id));
  /** Збіг з розкладом — окремою «пігулкою» під фактами; решта бейджів — у рядку системи. */
  protected readonly fit = computed<BadgeVm | null>(
    () => this.game().badges.find((b) => b.kind === 'fit') ?? null,
  );
  protected readonly marks = computed(() => {
    const fit = this.fit();
    return this.game().badges.filter((b) => b !== fit);
  });
  protected readonly gameUrl = computed(() => `/games/${this.game().id}`);

  private readonly router = inject(Router);
  private readonly host: HTMLElement = inject(ElementRef).nativeElement;
  /** Перехід триває — повторний (подвійний) клік нічого не робить. */
  private navigating = false;

  protected onCardClick(event: MouseEvent): void {
    if (!isCardOpenClick(event, this.host, { respectSelection: true })) return;
    event.preventDefault();
    if (this.navigating) return;
    this.navigating = true;
    // Перехід завершився (успішно, скасовано guard-ом чи впав) — наступний клік пробує знову:
    // картка може пережити перехід (повторне використання маршруту, та сама адреса).
    const done = () => (this.navigating = false);
    this.router.navigateByUrl(this.gameUrl()).then(done, done);
  }

  /** «Діоди» місць: світяться вільні (декор; число — у тексті поруч). */
  protected readonly pips = computed<boolean[]>(() => {
    const g = this.game();
    if (g.restricted || g.maxPlayers > MAX_PIPS) return [];
    return Array.from({ length: g.maxPlayers }, (_, i) => i < g.freeSlots);
  });
}
