import type { ThemeSlots } from '../../slots';
import { QuestBoardBadge } from './badge/quest-board-badge';
import { QuestBoardEmptyState } from './empty-state/quest-board-empty-state';
import { QuestBoardGameCard } from './game-card/quest-board-game-card';
import { QuestBoardGmSignature } from './gm-signature/quest-board-gm-signature';
import { QuestBoardMyGameItem } from './my-game-item/quest-board-my-game-item';
import { QuestBoardPageHeader } from './page-header/quest-board-page-header';
import { QuestBoardShell } from './shell/quest-board-shell';

/** Слоти дизайну «Дошка оголошень» (лінивий чанк, див. `THEMES`). */
export const QUEST_BOARD_SLOTS: ThemeSlots = {
  shell: QuestBoardShell,
  'game-card': QuestBoardGameCard,
  'my-game-item': QuestBoardMyGameItem,
  'page-header': QuestBoardPageHeader,
  'empty-state': QuestBoardEmptyState,
  badge: QuestBoardBadge,
  'gm-signature': QuestBoardGmSignature,
};
