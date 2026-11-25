import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import type { BadgeVm, GameCardVm } from '../../../../core/games/game-card.vm';
import type { GameCardSlot } from '../../../slots';
import { QuestBoardBadge } from '../badge/quest-board-badge';
import { QuestBoardGmSignature } from '../gm-signature/quest-board-gm-signature';

/** Скільки різних нахилів має дошка (набір кутів — у стилях, `data-tilt`). */
const TILTS = 6;

/**
 * Слот `game-card` дизайну «Дошка оголошень»: оголошення, приколоте шпилькою до стіни.
 * Збіг з розкладом — стрічка з моху, ціна — сургучна печатка, далі «Коли / Де / Місця» і
 * підпис майстра. Обмежена картка — лише назва, вік і майстер під «завісою».
 */
@Component({
  selector: 'nri-qb-game-card',
  imports: [RouterLink, MatIconModule, TranslatePipe, QuestBoardBadge, QuestBoardGmSignature],
  templateUrl: './quest-board-game-card.html',
  styleUrl: './quest-board-game-card.less',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuestBoardGameCard implements GameCardSlot {
  readonly game = input.required<GameCardVm>();

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
}
