import type { ThemeSlots } from '../../slots';
import { ClassicBadge } from './badge/classic-badge';
import { ClassicEmptyState } from './empty-state/classic-empty-state';
import { ClassicGameCard } from './game-card/classic-game-card';
import { ClassicGmSignature } from './gm-signature/classic-gm-signature';
import { ClassicMyGameItem } from './my-game-item/classic-my-game-item';
import { ClassicPageHeader } from './page-header/classic-page-header';
import { ClassicShell } from './shell/classic-shell';

/** Слоти дизайну «Класичний» (лінивий чанк, див. `THEMES`). */
export const CLASSIC_SLOTS: ThemeSlots = {
  shell: ClassicShell,
  'game-card': ClassicGameCard,
  'my-game-item': ClassicMyGameItem,
  'page-header': ClassicPageHeader,
  'empty-state': ClassicEmptyState,
  badge: ClassicBadge,
  'gm-signature': ClassicGmSignature,
};
